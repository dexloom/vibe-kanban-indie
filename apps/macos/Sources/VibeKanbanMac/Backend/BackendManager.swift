import Foundation
import Observation

enum BackendMode: String, CaseIterable, Identifiable {
    case managed   // the app spawns + supervises the server
    case external  // the user runs the server themselves
    var id: String { rawValue }
    var label: String { self == .managed ? "Managed (built-in)" : "External" }
}

/// Spawns and supervises the Rust `server` binary as a child process so the app
/// has a built-in backend. Resolves the executable from (1) a binary bundled in
/// the app, (2) an explicit path in Settings, or (3) `target/{release,debug}/server`
/// under a configured repo path (optionally building it first with cargo).
///
/// The server auto-assigns a port (`BACKEND_PORT=0`) and writes it to
/// `$TMPDIR/vibe-kanban/vibe-kanban.port`, which we poll. The child is sent
/// SIGTERM on `stop()` / app quit.
@MainActor
@Observable
final class BackendManager {
    enum State: Equatable {
        case stopped
        case building
        case starting
        case running(URL)
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .building: return "Building…"
            case .starting: return "Starting…"
            case .running(let u): return "Running (\(u.host ?? "")):\(u.port ?? 0)"
            case .failed(let m): return "Failed: \(m)"
            }
        }
    }

    // UserDefaults keys (shared with the Settings UI via @AppStorage).
    static let modeKey = "backendMode"
    static let exePathKey = "backendExecutablePath"
    static let repoPathKey = "backendRepoPath"
    static let buildFromSourceKey = "backendBuildFromSource"

    private(set) var state: State = .stopped
    private(set) var log: String = ""

    private var process: Process?
    private var intentionalStop = false

    var mode: BackendMode {
        BackendMode(rawValue: UserDefaults.standard.string(forKey: Self.modeKey) ?? "") ?? .managed
    }

    var failureMessage: String? {
        if case .failed(let m) = state { return m }
        return nil
    }

    // MARK: - Lifecycle

    /// Resolve, (optionally build,) spawn the server and wait until it's healthy.
    /// Returns the resulting state.
    @discardableResult
    func start() async -> State {
        if case .running = state { return state }
        intentionalStop = false
        state = .starting
        log = ""

        BackendDiscovery.removeStalePortFile()

        var exe = resolveExecutable()
        if exe == nil, buildFromSource, let repo = repoURL {
            state = .building
            let ok = await runCargoBuild(repo: repo)
            guard ok else { state = .failed("cargo build failed — see log"); return state }
            exe = resolveExecutable()
        }
        guard let executable = exe else {
            state = .failed("No backend binary. Set an executable path or a repo path (with build-from-source) in Settings → Backend.")
            return state
        }

        state = .starting
        do {
            try spawn(executable: executable)
        } catch {
            state = .failed("Failed to launch: \(error.localizedDescription)")
            return state
        }

        guard let port = await waitForPortFile(attempts: buildFromSource ? 120 : 60) else {
            stop()
            state = .failed("Backend did not report a port. See log.")
            return state
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)") else {
            stop(); state = .failed("Bad backend URL."); return state
        }
        if await waitForHealth(url, attempts: 40) {
            state = .running(url)
        } else {
            stop()
            state = .failed("Backend started but never became healthy.")
        }
        return state
    }

    func stop() {
        intentionalStop = true
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
        if case .running = state { state = .stopped }
        else if case .starting = state { state = .stopped }
    }

    // MARK: - Resolution

    private var repoURL: URL? {
        let p = UserDefaults.standard.string(forKey: Self.repoPathKey) ?? ""
        return p.isEmpty ? nil : URL(fileURLWithPath: p)
    }

    private var buildFromSource: Bool {
        UserDefaults.standard.bool(forKey: Self.buildFromSourceKey)
    }

    func resolveExecutable() -> URL? {
        // 1. Bundled binary (Contents/Resources/Backend/server or .../server).
        if let bundled = Bundle.main.url(forResource: "server", withExtension: nil, subdirectory: "Backend")
            ?? Bundle.main.url(forResource: "server", withExtension: nil) {
            return bundled
        }
        // 2. Explicit path.
        let explicit = UserDefaults.standard.string(forKey: Self.exePathKey) ?? ""
        if !explicit.isEmpty, isExecutable(explicit) {
            return URL(fileURLWithPath: explicit)
        }
        // 3. Built binary under the repo.
        if let repo = repoURL {
            for sub in ["target/release/server", "target/debug/server"] {
                let candidate = repo.appendingPathComponent(sub)
                if isExecutable(candidate.path) { return candidate }
            }
        }
        return nil
    }

    private func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    // MARK: - Process

    private func spawn(executable: URL) throws {
        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = repoURL ?? executable.deletingLastPathComponent()

        var env = ProcessInfo.processInfo.environment
        env["HOST"] = "127.0.0.1"
        env["BACKEND_PORT"] = "0"          // auto-assign; written to the port file
        env["PREVIEW_PROXY_PORT"] = "0"
        env["RUST_LOG"] = env["RUST_LOG"] ?? "info"
        env["DISABLE_WORKTREE_CLEANUP"] = "1"
        process.environment = env

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(text) }
        }
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in self?.handleTermination(code: proc.terminationStatus) }
        }

        try process.run()
        self.process = process
        appendLog("▶︎ launched \(executable.path)\n")
    }

    private func handleTermination(code: Int32) {
        guard !intentionalStop else { return }
        if case .running = state {
            state = .failed("Backend exited (code \(code)). See log.")
        }
    }

    private func appendLog(_ text: String) {
        log += text
        if log.count > 100_000 { log = String(log.suffix(100_000)) }
    }

    // MARK: - Readiness

    private func waitForPortFile(attempts: Int) async -> Int? {
        for _ in 0..<attempts {
            if process?.isRunning == false { return nil }   // died early
            if let port = BackendDiscovery.readPortFromTemp() { return port }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return nil
    }

    private func waitForHealth(_ base: URL, attempts: Int) async -> Bool {
        for _ in 0..<attempts {
            var req = URLRequest(url: base.appendingPathComponent("health"))
            req.timeoutInterval = 2
            if let (_, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse, (200..<500).contains(http.statusCode) {
                return true
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return false
    }

    private func runCargoBuild(repo: URL) async -> Bool {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["cargo", "build", "--release", "--bin", "server"]
            process.currentDirectoryURL = repo
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
                Task { @MainActor in self?.appendLog(text) }
            }
            process.terminationHandler = { proc in
                continuation.resume(returning: proc.terminationStatus == 0)
            }
            do { try process.run() } catch { continuation.resume(returning: false) }
        }
    }
}
