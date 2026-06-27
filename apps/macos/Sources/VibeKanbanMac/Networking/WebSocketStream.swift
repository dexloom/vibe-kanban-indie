import Foundation

/// Wraps a `URLSessionWebSocketTask` as an `AsyncStream<LogMsg>`.
///
/// NOTE: some backend WS routes may require a relay signature even locally; if a
/// stream closes immediately, views fall back to polling. Build the URL from the
/// REST base by swapping the scheme to `ws`.
final class WebSocketStream {
    private let task: URLSessionWebSocketTask
    private var continuation: AsyncStream<LogMsg>.Continuation?

    init(url: URL) {
        let session = URLSession(configuration: .default)
        self.task = session.webSocketTask(with: url)
    }

    /// Build a WS URL for a path like `/execution-processes/{id}/raw-logs/ws`.
    static func url(base: URL, path: String, query: [URLQueryItem] = []) -> URL? {
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        comps.scheme = (base.scheme == "https") ? "wss" : "ws"
        comps.path = path
        if !query.isEmpty { comps.queryItems = query }
        return comps.url
    }

    func messages() -> AsyncStream<LogMsg> {
        AsyncStream { continuation in
            self.continuation = continuation
            self.task.resume()
            self.receiveLoop()
            continuation.onTermination = { [weak self] _ in
                self?.task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    private func receiveLoop() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.continuation?.finish()
            case .success(let message):
                switch message {
                case .string(let text):
                    self.continuation?.yield(LogMsg.decode(from: text))
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.continuation?.yield(LogMsg.decode(from: text))
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            }
        }
    }

    func cancel() {
        task.cancel(with: .goingAway, reason: nil)
        continuation?.finish()
    }
}
