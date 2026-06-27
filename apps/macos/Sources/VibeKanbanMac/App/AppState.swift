import Foundation
import Observation

enum ConnectionState: Equatable {
    case unknown
    case connecting
    case connected
    case disconnected(String)

    var label: String {
        switch self {
        case .unknown: return "Not connected"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .disconnected(let m): return m
        }
    }

    var isConnected: Bool { self == .connected }
}

/// What the sidebar selection points at.
enum SidebarSelection: Hashable {
    case project(String)
    case workspaces
}

/// Global, app-wide state: backend connection, the project list, the sidebar
/// selection, and a cache of per-project board view models so switching between
/// projects is instant (data refreshes in the background).
@MainActor
@Observable
final class AppState {
    var connection: ConnectionState = .unknown
    var baseURL: URL?
    var client: APIClient?

    var projects: [Project] = []
    var selection: SidebarSelection?
    var members: [UserData] = []

    /// Cached board models keyed by project id — kept alive across selection so
    /// previously-loaded boards reappear instantly.
    var boards: [String: BoardViewModel] = [:]

    var showCommandPalette = false
    var lastError: String?

    /// Supervises a built-in backend process when in managed mode.
    let backend = BackendManager()

    var selectedProjectId: String? {
        if case .project(let id) = selection { return id }
        return nil
    }

    var selectedProject: Project? {
        projects.first { $0.id == selectedProjectId }
    }

    func board(for project: Project) -> BoardViewModel? {
        boards[project.id]
    }

    func memberName(_ userId: String) -> String {
        members.first { $0.userId == userId }?.displayName ?? String(userId.prefix(6))
    }

    /// Connect to a backend: reuse one that's already running, else (in managed
    /// mode) spawn the built-in server, else report that none is available.
    func bootstrap() async {
        connection = .connecting

        // 1. Reuse a backend that's already running (manual, or one we started).
        if let url = BackendDiscovery.resolveBaseURL(), await isHealthy(url) {
            finishConnect(url)
            return
        }
        // 2. Managed mode: spawn and supervise our own.
        if backend.mode == .managed {
            let state = await backend.start()
            if case .running(let url) = state {
                finishConnect(url)
            } else {
                connection = .disconnected(backend.failureMessage ?? "Could not start the managed backend.")
            }
            return
        }
        // 3. External mode, nothing running.
        connection = .disconnected("Backend not running. Start it, or switch to the managed backend in Settings → Backend.")
    }

    private func isHealthy(_ url: URL) async -> Bool {
        await APIClient(baseURL: url).ping()
    }

    private func finishConnect(_ url: URL) {
        baseURL = url
        client = APIClient(baseURL: url)
        connection = .connected            // render immediately
        Task { await reloadProjects() }    // data fills in in the background
    }

    /// Stop any managed backend and reconnect (used by Settings → Backend).
    func restartManagedBackend() async {
        backend.stop()
        await bootstrap()
    }

    /// Called on app termination to stop a managed backend.
    func shutdownBackend() {
        backend.stop()
    }

    func reloadProjects() async {
        guard let client else { return }
        do {
            let fetched = try await client.listProjects().sorted { $0.sortOrder < $1.sortOrder }
            projects = fetched
            // Create board models for new projects; keep existing ones (and their
            // cached data) intact.
            for project in fetched where boards[project.id] == nil {
                boards[project.id] = BoardViewModel(project: project, client: client)
            }
            if selection == nil, let first = fetched.first {
                selection = .project(first.id)
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            if !connection.isConnected {
                connection = .disconnected(error.localizedDescription)
            }
        }
    }
}
