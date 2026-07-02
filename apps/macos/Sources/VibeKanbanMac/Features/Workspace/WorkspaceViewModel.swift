import Foundation
import Observation

/// Drives the workspace/session window: sessions, the live conversation (via the
/// normalized-logs WebSocket with an `agent-progress` polling fallback), raw
/// logs, and pending approvals.
@MainActor
@Observable
final class WorkspaceViewModel {
    let workspaceId: String
    private let client: APIClient

    var workspace: Workspace?
    var sessions: [Session] = []
    var selectedSessionId: String? {
        didSet {
            if selectedSessionId != nil { isNewSessionMode = false }
            Task { await loadSession() }
        }
    }
    /// Mirrors web's `useWorkspaceSessions` new-session mode: true when the
    /// operator explicitly started a new session, or the workspace has zero
    /// sessions. The composer routes its send target off this flag.
    var isNewSessionMode = false
    var executions: [ExecutionProcess] = []

    var entries: [NormalizedEntry] = []
    var rawLog: String = ""
    var diffs: [DiffEntry] = []
    var pendingApprovals: [ApprovalInfo] = []
    var streamConnected = false
    var error: String?

    private var applier = ConversationPatchApplier()
    private var diffApplier = DiffStreamApplier()
    private var normalizedStream: WebSocketStream?
    private var rawStream: WebSocketStream?
    private var diffStream: WebSocketStream?
    private var streamTask: Task<Void, Never>?
    private var rawTask: Task<Void, Never>?
    private var diffTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(workspaceId: String, client: APIClient) {
        self.workspaceId = workspaceId
        self.client = client
    }

    var activeExecution: ExecutionProcess? {
        executions.last { $0.runReason == .codingagent } ?? executions.last
    }

    /// The latest running, interactive coding-agent execution — the gate for
    /// the Terminal pane's headed-attach affordance. Distinct from
    /// `activeExecution` (used for logs/approvals), which stays keyed off
    /// "most recent coding-agent execution" regardless of liveness. Mirrors
    /// the web's headed-live gate (`SessionChatBoxContainer.tsx:546-555`).
    var liveHeadedExecution: ExecutionProcess? {
        executions.last { $0.isLiveInteractiveCodingAgent }
    }

    /// The currently selected session, or nil in new-session mode.
    var selectedSession: Session? {
        sessions.first { $0.id == selectedSessionId }
    }

    /// Whether the streamed diff spans more than one repo (drives whether the
    /// Changes pane prefixes file paths with the repo name).
    var diffsSpanRepos: Bool { diffApplier.multiRepo }

    func load() async {
        workspace = try? await client.getWorkspace(id: workspaceId)
        startDiffStream()   // workspace-level; independent of the selected session
        sessions = (try? await client.listSessions(workspaceId: workspaceId)) ?? []
        if sessions.isEmpty {
            // Zero sessions ⇒ new-session mode (web treats this the same as an
            // explicit "New session" click).
            isNewSessionMode = true
            await loadSession()
        } else if selectedSessionId == nil {
            selectedSessionId = sessions.first?.id   // most-recently-used-first; triggers loadSession via didSet
        } else {
            await loadSession()
        }
    }

    /// Enter new-session mode (the "New session" affordance): clears the
    /// selection (tearing down the current session's streams via
    /// `loadSession()`'s early return) and marks new-session mode so the
    /// composer routes to `createSessionAndSend`.
    func startNewSession() {
        isNewSessionMode = true
        selectedSessionId = nil   // triggers loadSession via didSet (clears state)
    }

    func loadSession() async {
        stopStreams()
        entries = []
        rawLog = ""
        applier = ConversationPatchApplier()
        guard let sid = selectedSessionId else { return }
        executions = (try? await client.listExecutions(sessionId: sid)) ?? []
        startStreaming()
        startPollingApprovals()
    }

    // MARK: - Streaming

    private func startStreaming() {
        guard let exec = activeExecution else { return }

        if let url = WebSocketStream.url(
            base: client.baseURL,
            path: "/api/execution-processes/\(exec.id)/normalized-logs/ws") {
            let stream = WebSocketStream(url: url)
            normalizedStream = stream
            streamTask = Task { [weak self] in
                for await msg in stream.messages() {
                    guard let self else { break }
                    await MainActor.run { self.handleNormalized(msg) }
                }
            }
        }

        if let url = WebSocketStream.url(
            base: client.baseURL,
            path: "/api/execution-processes/\(exec.id)/raw-logs/ws") {
            let stream = WebSocketStream(url: url)
            rawStream = stream
            rawTask = Task { [weak self] in
                for await msg in stream.messages() {
                    guard let self else { break }
                    await MainActor.run { self.handleRaw(msg) }
                }
            }
        }
    }

    private func handleNormalized(_ msg: LogMsg) {
        switch msg {
        case .ready:
            streamConnected = true
        case .jsonPatch(let ops):
            streamConnected = true
            applier.apply(ops: ops)
            entries = applier.sorted
        case .finished:
            streamConnected = true
        default:
            break
        }
    }

    private func handleRaw(_ msg: LogMsg) {
        switch msg {
        case .stdout(let s), .stderr(let s):
            rawLog += s
            if rawLog.count > 200_000 { rawLog = String(rawLog.suffix(200_000)) }
        default:
            break
        }
    }

    private func stopStreams() {
        streamTask?.cancel(); streamTask = nil
        rawTask?.cancel(); rawTask = nil
        normalizedStream?.cancel(); normalizedStream = nil
        rawStream?.cancel(); rawStream = nil
        streamConnected = false
    }

    // MARK: - Diff stream (workspace-level)

    /// Stream the workspace's git diff over `/workspaces/{id}/git/diff/ws`. The
    /// diff is keyed by repo+file and survives session switches (it reflects the
    /// worktree, not a single execution), so it lives for the window's lifetime.
    private func startDiffStream() {
        diffTask?.cancel()
        diffStream?.cancel()
        diffApplier.reset()
        diffs = []
        guard let url = WebSocketStream.url(
            base: client.baseURL,
            path: "/api/workspaces/\(workspaceId)/git/diff/ws") else { return }
        let stream = WebSocketStream(url: url)
        diffStream = stream
        diffTask = Task { [weak self] in
            for await msg in stream.messages() {
                guard let self else { break }
                await MainActor.run { self.handleDiff(msg) }
            }
        }
    }

    private func handleDiff(_ msg: LogMsg) {
        switch msg {
        case .jsonPatch(let ops):
            diffApplier.apply(ops: ops)
            diffs = diffApplier.entries
        default:
            break
        }
    }

    private func stopDiffStream() {
        diffTask?.cancel(); diffTask = nil
        diffStream?.cancel(); diffStream = nil
    }

    // MARK: - Approvals (polling)

    private func startPollingApprovals() {
        pollTask?.cancel()
        guard let exec = activeExecution else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                let pending = (try? await self.client.pendingApprovals(executionId: exec.id)) ?? []
                await MainActor.run { self.pendingApprovals = pending }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func respond(to approval: ApprovalInfo, outcome: ApprovalOutcome) async {
        let response = ApprovalResponse(executionProcessId: approval.executionProcessId, status: outcome)
        do {
            try await client.respondToApproval(approvalId: approval.approvalId, response)
            pendingApprovals.removeAll { $0.approvalId == approval.approvalId }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Follow-up / send

    /// The executor config to use for the next message: the selected session's
    /// own executions (newest first) → the session's / most-recent session's
    /// `executor` field → `.defaultConfig`. Mirrors the web's precedence
    /// (`SessionChatBoxContainer.tsx`); never hardcodes an executor for an
    /// established session, so follow-ups don't trip `ExecutorMismatch`.
    private func currentExecutorConfig() -> ExecutorConfig {
        deriveExecutorConfig(executions: executions, session: selectedSession, fallbackSessions: sessions)
            ?? .defaultConfig
    }

    /// Single entry point for the composer: routes to the create-session flow
    /// in new-session mode (or when nothing is selected — a zero-session
    /// workspace), otherwise sends a follow-up to the selected session.
    func send(_ prompt: String) async {
        if isNewSessionMode || selectedSessionId == nil {
            await createSessionAndSend(prompt)
        } else {
            await sendFollowUp(prompt)
        }
    }

    func sendFollowUp(_ prompt: String) async {
        guard let sid = selectedSessionId else { return }
        do {
            try await client.followUp(sessionId: sid, CreateFollowUpAttempt(prompt: prompt, executorConfig: currentExecutorConfig()))
            await loadSession()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// New-session mode's first send (mirrors web's `useCreateSession` +
    /// `useSessionSend`): create an empty session, deliver the prompt as its
    /// first follow-up, refresh the list, then select the new session (which
    /// exits new-session mode via `selectedSessionId`'s `didSet`).
    func createSessionAndSend(_ prompt: String) async {
        // A brand-new session has no executions of its own yet — fall back to
        // the most-recently-used session's executor, else the app default.
        let config = deriveExecutorConfig(executions: [], session: nil, fallbackSessions: sessions)
            ?? .defaultConfig
        do {
            let newSession = try await client.createSession(CreateSessionRequest(workspaceId: workspaceId))
            try await client.followUp(sessionId: newSession.id, CreateFollowUpAttempt(prompt: prompt, executorConfig: config))
            sessions = (try? await client.listSessions(workspaceId: workspaceId)) ?? sessions
            selectedSessionId = newSession.id   // triggers loadSession via didSet; clears isNewSessionMode
        } catch {
            self.error = error.localizedDescription
        }
    }

    func teardown() {
        stopStreams()
        stopDiffStream()
        pollTask?.cancel(); pollTask = nil
    }
}
