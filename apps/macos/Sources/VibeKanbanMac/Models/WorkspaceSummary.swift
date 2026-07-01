import Foundation

/// Board-side summary of a workspace linked to an issue (the "remote"
/// `Workspace` wire shape). Served by `/v1/fallback/project_workspaces` and
/// surfaced as a sub-card on the kanban board. Distinct from the execution-side
/// `Workspace` (see Workspace.swift) used by the workspace/chat window.
struct WorkspaceSummary: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let ownerUserId: String
    let issueId: String?
    let localWorkspaceId: String?
    var name: String?
    var archived: Bool
    var filesChanged: Int?
    var linesAdded: Int?
    var linesRemoved: Int?
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case ownerUserId = "owner_user_id"
        case issueId = "issue_id"
        case localWorkspaceId = "local_workspace_id"
        case name, archived
        case filesChanged = "files_changed"
        case linesAdded = "lines_added"
        case linesRemoved = "lines_removed"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct WorkspaceSummariesResponse: Codable { let workspaces: [WorkspaceSummary] }
