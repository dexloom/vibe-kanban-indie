import Foundation

/// A kanban column. Mirrors `remote-types.ts` `ProjectStatus`; served by
/// `/v1/fallback/project_statuses?project_id=`.
struct ProjectStatus: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    var name: String
    var color: String
    var sortOrder: Double
    var hidden: Bool
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case name, color
        case sortOrder = "sort_order"
        case hidden
        case createdAt = "created_at"
    }
}

struct ProjectStatusesResponse: Codable { let project_statuses: [ProjectStatus] }
