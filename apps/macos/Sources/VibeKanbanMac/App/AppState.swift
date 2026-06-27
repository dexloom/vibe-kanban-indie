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

    /// Discover the backend, verify it, and load the project list.
    func bootstrap() async {
        connection = .connecting
        guard let url = BackendDiscovery.resolveBaseURL() else {
            connection = .disconnected("Backend not found — start the vibe-kanban server, or set a port in Settings.")
            return
        }
        baseURL = url
        let client = APIClient(baseURL: url)
        self.client = client
        // Optimistic: render the UI immediately; data fills in as it arrives.
        connection = .connected
        await reloadProjects()
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
