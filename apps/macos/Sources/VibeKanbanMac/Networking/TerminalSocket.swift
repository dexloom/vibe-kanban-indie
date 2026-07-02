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

    private func receiveLoop(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.task === task else { return }
                switch result {
                case .failure:
                    // A receive failure not preceded by a clean
                    // `didCloseWith` is a transient drop — reconnect.
                    self.handleDisconnect(cleanClose: false)
                case .success(let message):
                    switch message {
                    case .string(let text): self.handleIncoming(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) { self.handleIncoming(text) }
                    @unknown default:
                        break
                    }
                    self.receiveLoop(task: task)
                }
            }
        }
    }

    private func handleIncoming(_ text: String) {
        guard let msg = TerminalMessage.decode(from: text) else { return }
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
        Task { @MainActor in self.handleDisconnect(cleanClose: closeCode == .normalClosure) }
    }
}
