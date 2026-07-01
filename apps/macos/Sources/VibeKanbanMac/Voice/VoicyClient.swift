import Foundation
import AppKit

/// Errors surfaced by `VoicyClient`.
enum VoiceError: LocalizedError, Equatable {
    case notInstalled
    case notReachable
    case cancelled
    case server(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Voicy isn't installed. Install Voicy to use voice input."
        case .notReachable: return "Couldn't reach Voicy. Is it running?"
        case .cancelled: return "Dictation cancelled."
        case .server(let m): return m
        }
    }
}

/// Talks to Voicy's local dictation control server over loopback HTTP. The mic
/// just *opens* Voicy for a dictation session; the user records/refines inside
/// Voicy and clicks "Send to vibe-kanban". This client opens the session and
/// polls until that Send lands (or the session is cancelled), then returns the
/// prepared text. Launches Voicy if it isn't already running.
actor VoicyClient {
    private let session: URLSession
    /// Fixed base URL that bypasses port-file discovery + app launch. Used by
    /// tests (and available for a manual Settings override later).
    private let baseURLOverride: URL?

    init(session: URLSession? = nil, baseURLOverride: URL? = nil) {
        self.baseURLOverride = baseURLOverride
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    private func resolveBase() -> URL? { baseURLOverride ?? VoicyDiscovery.resolveBaseURL() }

    // MARK: - Public API

    /// Open a dictation session in `mode`, sending `context` to bias
    /// transcription, then await the user's "Send to vibe-kanban" in Voicy and
    /// return the prepared text. Throws `.cancelled` if the session is cancelled
    /// (in Voicy or via Swift task cancellation). Ensures Voicy is running first.
    func requestDictation(mode: DictationMode, agentId: String? = nil,
                          context: DictationContext) async throws -> String {
        let base = try await ensureRunning()
        let body = try JSONEncoder().encode(
            SessionBody(context: context, mode: mode.rawValue, agentId: agentId))
        let data = try await post(base.appendingPathComponent("dictate/session"), body: body)
        let started = try JSONDecoder().decode(SessionResponse.self, from: data)
        guard let id = started.sessionId else { throw VoiceError.server(started.error ?? "Could not open Voicy.") }

        // Poll for the user's Send. Generous cap so an abandoned session can't
        // wait forever; the mic UI also offers an explicit cancel.
        for _ in 0..<850 {   // ~10 min at 700ms
            if Task.isCancelled {
                await cancel(sessionId: id)
                throw VoiceError.cancelled
            }
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let base = resolveBase() else { throw VoiceError.notReachable }
            let statusData = try await get(base.appendingPathComponent("dictate/session/\(id)"))
            let status = try JSONDecoder().decode(StatusResponse.self, from: statusData)
            switch status.status {
            case "sent": return status.text ?? ""
            case "cancelled": throw VoiceError.cancelled
            default: continue   // pending
            }
        }
        await cancel(sessionId: id)
        throw VoiceError.cancelled
    }

    /// The Voicy agents available for the situation→agent mapping. Does *not*
    /// launch Voicy — returns `.notReachable` if it isn't running.
    func listAgents() async throws -> [VoicyAgent] {
        guard let base = resolveBase() else { throw VoiceError.notReachable }
        let data = try await get(base.appendingPathComponent("agents"))
        return (try JSONDecoder().decode(AgentsResponse.self, from: data)).agents
    }

    /// Cancel a session (best-effort).
    func cancel(sessionId: String) async {
        guard let base = resolveBase() else { return }
        _ = try? await post(base.appendingPathComponent("dictate/session/\(sessionId)/cancel"),
                            body: Data("{}".utf8))
    }

    // MARK: - Lifecycle / discovery

    private func ensureRunning() async throws -> URL {
        if let url = resolveBase(), await isHealthy(url) {
            return url
        }
        try await launch()
        for _ in 0..<60 {   // ~15s while Voicy starts
            try? await Task.sleep(nanoseconds: 250_000_000)
            if let url = resolveBase(), await isHealthy(url) {
                return url
            }
        }
        throw VoiceError.notReachable
    }

    private func launch() async throws {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: VoicyDiscovery.bundleID) else {
            throw VoiceError.notInstalled
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        _ = try await NSWorkspace.shared.openApplication(at: appURL, configuration: config)
    }

    private func isHealthy(_ base: URL) async -> Bool {
        var req = URLRequest(url: base.appendingPathComponent("health"))
        req.timeoutInterval = 2
        guard let (_, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200
        else { return false }
        return true
    }

    // MARK: - HTTP

    private func get(_ url: URL) async throws -> Data {
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        return try await run(req)
    }

    private func post(_ url: URL, body: Data) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return try await run(req)
    }

    private func run(_ req: URLRequest) async throws -> Data {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw VoiceError.notReachable }
            guard (200..<300).contains(http.statusCode) else {
                let msg = (try? JSONDecoder().decode(StatusResponse.self, from: data))?.error
                throw VoiceError.server(msg ?? "Voicy error (HTTP \(http.statusCode)).")
            }
            return data
        } catch let e as VoiceError {
            throw e
        } catch {
            throw VoiceError.notReachable
        }
    }
}

// MARK: - Wire types

/// A Voicy agent the user can map a situation to.
struct VoicyAgent: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
}

private struct AgentsResponse: Decodable {
    let agents: [VoicyAgent]
}

private struct SessionBody: Encodable {
    let context: DictationContext
    let mode: String
    let agentId: String?
}

private struct SessionResponse: Decodable {
    let sessionId: String?
    let error: String?
}

/// Covers `{ status, text? }` and `{ error }`.
private struct StatusResponse: Decodable {
    let status: String?
    let text: String?
    let error: String?
}
