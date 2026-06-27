import Foundation

/// Discovers the local backend base URL.
///
/// The Rust server writes `$TMPDIR/vibe-kanban/vibe-kanban.port` on startup
/// (see `crates/utils/src/port_file.rs`) as JSON `{"main_port":…}` (older
/// builds write a bare integer). A manual override in Settings always wins.
enum BackendDiscovery {
    static let overrideKey = "backendBaseURLOverride"

    private struct PortInfo: Codable {
        let main_port: Int
        let preview_proxy_port: Int?
    }

    /// Resolve the base URL, or `nil` if the backend can't be located.
    static func resolveBaseURL() -> URL? {
        if let override = manualOverride() { return override }
        if let port = readPortFromTemp() {
            return URL(string: "http://127.0.0.1:\(port)")
        }
        return nil
    }

    static func manualOverride() -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: overrideKey),
              !raw.trimmingCharacters(in: .whitespaces).isEmpty
        else { return nil }
        // Accept either a full URL or a bare port number.
        if let port = Int(raw.trimmingCharacters(in: .whitespaces)) {
            return URL(string: "http://127.0.0.1:\(port)")
        }
        return URL(string: raw)
    }

    static func readPortFromTemp() -> Int? {
        for dir in candidateTempDirs() {
            let path = dir
                .appendingPathComponent("vibe-kanban", isDirectory: true)
                .appendingPathComponent("vibe-kanban.port")
            guard let data = try? Data(contentsOf: path) else { continue }
            if let info = try? JSONDecoder().decode(PortInfo.self, from: data) {
                return info.main_port
            }
            if let s = String(data: data, encoding: .utf8),
               let p = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return p
            }
        }
        return nil
    }

    private static func candidateTempDirs() -> [URL] {
        var dirs: [URL] = []
        if let t = ProcessInfo.processInfo.environment["TMPDIR"] {
            dirs.append(URL(fileURLWithPath: t))
        }
        dirs.append(URL(fileURLWithPath: NSTemporaryDirectory()))
        dirs.append(URL(fileURLWithPath: "/tmp"))
        return dirs
    }
}
