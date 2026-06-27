import Foundation

/// Discovers the local Voicy dictation control server.
///
/// Voicy's `DictationIPCServer` writes its loopback port to `~/.voicy/voicy.port`
/// (mirroring this app's own `vibe-kanban.port` discovery — see
/// `Networking/PortDiscovery.swift`). The base URL is `http://127.0.0.1:<port>`.
enum VoicyDiscovery {
    /// Voicy's bundle identifier, used to launch it via `NSWorkspace`.
    static let bundleID = "com.sombrax.voicy"

    static var portFile: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".voicy/voicy.port")
    }

    /// The Voicy base URL from the port file, or `nil` if it isn't running.
    static func resolveBaseURL() -> URL? { resolveBaseURL(portFile: portFile) }

    /// Testable overload that reads the port from an arbitrary file.
    static func resolveBaseURL(portFile: URL) -> URL? {
        guard let data = try? Data(contentsOf: portFile),
              let raw = String(data: data, encoding: .utf8),
              let port = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              port > 0
        else { return nil }
        return URL(string: "http://127.0.0.1:\(port)")
    }
}
