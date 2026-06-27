import Foundation

/// Execution-side workspace (a git worktree where a coding agent runs).
/// Mirrors `shared/types.ts` `Workspace`; served by `/workspaces`.
/// Distinct from `WorkspaceSummary` (the board sub-card shape).
struct Workspace: Codable, Identifiable, Hashable {
    let id: String
    let taskId: String?
    let containerRef: String?
    var branch: String
    let setupCompletedAt: Date?
    let createdAt: Date
    let updatedAt: Date
    var archived: Bool
    var pinned: Bool
    var name: String?
    var worktreeDeleted: Bool
    var ephemeral: Bool
    var kind: WorkspaceKind?

    // Present on `WorkspaceWithStatus` (list endpoint); optional here.
    var isRunning: Bool?
    var isErrored: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case containerRef = "container_ref"
        case branch
        case setupCompletedAt = "setup_completed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case archived, pinned, name
        case worktreeDeleted = "worktree_deleted"
        case ephemeral, kind
        case isRunning = "is_running"
        case isErrored = "is_errored"
    }

    var displayName: String { name ?? branch }
}

enum WorkspaceKind: String, Codable, Hashable {
    case orchestrator
}
