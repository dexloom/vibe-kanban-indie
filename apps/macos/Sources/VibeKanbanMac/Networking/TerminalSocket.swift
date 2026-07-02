import Foundation

/// Pure backoff policy for terminal WS reconnects — web parity
/// (`TerminalProvider.tsx:394-411`): delay = `min(8000, 500 * 2^retry)` ms,
/// max 6 retries.
enum TerminalReconnectPolicy {
    static let maxRetries = 6

    /// The delay before the given (0-indexed) retry attempt, or `nil` once
    /// `maxRetries` is exhausted — callers should give up and surface the
    /// terminal state instead of scheduling another attempt.
    static func delay(retry: Int) -> TimeInterval? {
        guard retry < maxRetries else { return nil }
        return min(8.0, 0.5 * pow(2.0, Double(retry)))
    }
}

/// A thin WS client for the backend terminal protocol
/// (`GET /api/terminal/ws`): encodes `input`/`resize`, decodes
/// `output`/`error`, and reconnects with web-parity exponential backoff —
/// stopping on a clean close (code 1000) or an intentional `close()`, per the
/// backend's attach-error / session-end contract
/// (`crates/server/src/routes/terminal.rs::close_with_error`).
///
/// Networking runs on `URLSession`'s delegate queue; all callbacks and state
/// mutation are hopped onto the main actor.
@MainActor
final class TerminalSocket: NSObject {
    /// The resolved `/api/terminal/ws` endpoint (workspace/execution-process
    /// scoped query included). Internal (not private) so tests can assert on
    /// it without a live connection.
    let url: URL
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var retryCount = 0
    private var retryTask: Task<Void, Never>?
    private var intentionallyClosed = false
    private var disconnectHandled = false

    /// Decoded output bytes from the PTY.
    var onOutput: (Data) -> Void = { _ in }
    /// A server-side `error` frame (attach validation failure, PTY-create
    /// failure, or attach-session-end message).
    var onErrorMessage: (String) -> Void = { _ in }
    /// Fires with `true` once the handshake completes, `false` on any
    /// disconnect (transient or terminal).
    var onConnectionChange: (Bool) -> Void = { _ in }
    /// Fires when the connection ends **terminally** — a clean close (code
    /// 1000) or retries exhausted. The client must not reconnect afterward;
    /// callers should show the "disconnected" state without a spinner.
    var onTerminalEnd: () -> Void = {}

    /// - Parameters:
    ///   - executionProcessId: when set, attach to that process's headed tmux
    ///     session instead of spawning a plain workspace shell.
    ///   - initialCols/initialRows: the terminal view's current size at
    ///     connect time (falls back to the caller's default, e.g. 80×24 — the
    ///     server also defaults these).
    init?(
        base: URL,
        workspaceId: String,
        executionProcessId: String?,
        initialCols: Int,
        initialRows: Int
    ) {
        var query = [
            URLQueryItem(name: "workspace_id", value: workspaceId),
            URLQueryItem(name: "cols", value: String(initialCols)),
            URLQueryItem(name: "rows", value: String(initialRows)),
        ]
        if let executionProcessId {
            query.append(URLQueryItem(name: "execution_process_id", value: executionProcessId))
        }
        guard let url = WebSocketStream.url(base: base, path: "/api/terminal/ws", query: query) else {
            return nil
        }
        self.url = url
        super.init()
    }

    // MARK: - Lifecycle

    func connect() {
        guard !intentionallyClosed else { return }
        session?.invalidateAndCancel()
        disconnectHandled = false

        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receiveLoop(task: task)
    }

    /// Intentional teardown (view torn down / session switched / mode
    /// changed) — cancels the task and permanently suppresses reconnection.
    /// Does not fire `onTerminalEnd`: the caller already knows it's tearing
    /// this socket down.
    func close() {
        guard !intentionallyClosed else { return }
        intentionallyClosed = true
        retryTask?.cancel(); retryTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
        onConnectionChange(false)
    }

    // MARK: - Send

    func sendInput(_ bytes: Data) {
        send(.input(bytes))
    }

    func resize(cols: Int, rows: Int) {
        send(.resize(cols: cols, rows: rows))
    }

    /// No-ops while disconnected (mirrors the web's `readyState === OPEN`
    /// guard) — callers don't need to track connection state themselves.
    private func send(_ command: TerminalCommand) {
        guard let task, task.state == .running, let text = command.encode() else { return }
        task.send(.string(text)) { _ in }
    }

    // MARK: - Receive

    /// Pure decision: does this close code represent a **clean** server
    /// close (no reconnect)? The backend always pairs an `error` frame with
    /// a code-1000 close for attach-validation failures and session-end
    /// (`close_with_error`, terminal.rs), and a non-clean close for
    /// transient/PTY-create failures (`send_error`). `nonisolated` so it can
    /// be called from the receive loop's completion handler (which runs on
    /// the `URLSession` delegate queue, not the main actor) and from tests
    /// without an actor hop.
    nonisolated static func isCleanClose(_ closeCode: URLSessionWebSocketTask.CloseCode?) -> Bool {
        closeCode == .normalClosure
    }

    /// Decodes each frame **off the main actor** — `task.receive`'s
    /// completion handler runs on the `URLSession` delegate queue, so the
    /// JSON/base64 decode (`TerminalMessage.decode`, a pure, non-isolated
    /// function) happens there too; only the already-decoded payload hops to
    /// the main actor for `feed()`. Keeps heavy PTY output from allocating a
    /// `Task` + running `JSONSerialization` on the UI thread per frame.
    private func receiveLoop(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            switch result {
            case .failure:
                // A receive failure not preceded by a clean `didCloseWith`
                // may still *be* a clean close racing the failure — consult
                // the task's close code rather than assuming transient.
                let clean = Self.isCleanClose(task.closeCode)
                Task { @MainActor [weak self] in
                    guard let self, self.task === task else { return }
                    self.handleDisconnect(cleanClose: clean)
                }
            case .success(let message):
                let text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: text = nil
                }
                let decoded = text.flatMap { TerminalMessage.decode(from: $0) }
                Task { @MainActor [weak self] in
                    guard let self, self.task === task else { return }
                    if let decoded { self.handleDecoded(decoded) }
                    self.receiveLoop(task: task)
                }
            }
        }
    }

    private func handleDecoded(_ msg: TerminalMessage) {
        switch msg {
        case .output(let data): onOutput(data)
        case .error(let message): onErrorMessage(message)
        }
    }

    // MARK: - Disconnect / reconnect

    private func handleOpen() {
        disconnectHandled = false
        retryCount = 0
        onConnectionChange(true)
    }

    /// Idempotent: the delegate's `didCloseWith` and the receive loop's
    /// failure both observe the same disconnect, so only the first call acts.
    private func handleDisconnect(cleanClose: Bool) {
        guard !intentionallyClosed, !disconnectHandled else { return }
        disconnectHandled = true
        task = nil
        onConnectionChange(false)
        if cleanClose {
            onTerminalEnd()
            return
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard let delay = TerminalReconnectPolicy.delay(retry: retryCount) else {
            onTerminalEnd()
            return
        }
        retryCount += 1
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.connect() }
        }
    }
}

extension TerminalSocket: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        Task { @MainActor in self.handleOpen() }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor in self.handleDisconnect(cleanClose: Self.isCleanClose(closeCode)) }
    }
}
