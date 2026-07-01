import Foundation

// Board (kanban) entities. Wire shapes mirror `shared/remote-types.ts`,
// served locally by `/v1/fallback/*`.

/// A kanban project (board container). Served by `/v1/fallback/projects`.
struct Project: Codable, Identifiable, Hashable {
    let id: String
    let organizationId: String
    var name: String
    var color: String
    var sortOrder: Double
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case organizationId = "organization_id"
        case name, color
        case sortOrder = "sort_order"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// Minimal org member / user (from `/v1/organizations/{id}/members`).
struct UserData: Codable, Identifiable, Hashable {
    let userId: String
    let firstName: String?
    let lastName: String?
    let username: String?

    var id: String { userId }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case firstName = "first_name"
        case lastName = "last_name"
        case username
    }

    var displayName: String {
        let full = [firstName, lastName].compactMap { $0 }.joined(separator: " ")
        if !full.isEmpty { return full }
        return username ?? String(userId.prefix(6))
    }

    var initials: String {
        let parts = displayName.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first }
        return String(letters).uppercased()
    }
}

// MARK: - Fallback read envelopes

struct ProjectsResponse: Codable { let projects: [Project] }
struct MembersResponse: Codable { let users: [UserData] }
