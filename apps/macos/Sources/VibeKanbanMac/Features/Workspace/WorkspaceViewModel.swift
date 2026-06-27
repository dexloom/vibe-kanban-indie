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
    var selectedSessionId: String? { didSet { Task { await loadSession() } } }
    var executions: [ExecutionProcess] = []

    var entries: [NormalizedEntry] = []
    var rawLog: String = ""
    var pendingApprovals: [ApprovalInfo] = []
    var streamConnected = false
    var error: String?

    private var applier = ConversationPatchApplier()
    private var normalizedStream: WebSocketStream?
    private var rawStream: WebSocketStream?
    private var streamTask: Task<Void, Never>?
    private var rawTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(workspaceId: String, client: APIClient) {
        self.workspaceId = workspaceId
        self.client = client
    }

    var activeExecution: ExecutionProcess? {
        executions.last { $0.runReason == .codingagent } ?? executions.last
    }

    func load() async {
        workspace = try? await client.getWorkspace(id: workspaceId)
        sessions = (try? await client.listSessions(workspaceId: workspaceId)) ?? []
        if selectedSessionId == nil {
            selectedSessionId = sessions.last?.id   // triggers loadSession via didSet
        } else {
            await loadSession()
        }
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

    // MARK: - Follow-up

    func sendFollowUp(_ prompt: String, executor: ExecutorConfig = .defaultConfig) async {
        guard let sid = selectedSessionId else { return }
        do {
            try await client.followUp(sessionId: sid, CreateFollowUpAttempt(prompt: prompt, executorConfig: executor))
            await loadSession()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func teardown() {
        stopStreams()
        pollTask?.cancel(); pollTask = nil
    }
}
