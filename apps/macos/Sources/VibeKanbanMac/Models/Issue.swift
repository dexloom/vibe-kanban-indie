import Foundation

/// A kanban card. Wire shape mirrors `remote-types.ts` `Issue`; served by
/// `/v1/fallback/issues?project_id=`.
struct Issue: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let issueNumber: Int
    let simpleId: String
    var statusId: String
    var title: String
    var description: String?
    var priority: IssuePriority?
    var startDate: Date?
    var targetDate: Date?
    var completedAt: Date?
    var sortOrder: Double
    var parentIssueId: String?
    var parentIssueSortOrder: Double?
    var extensionMetadata: JSONValue?
    let creatorUserId: String?
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case issueNumber = "issue_number"
        case simpleId = "simple_id"
        case statusId = "status_id"
        case title, description, priority
        case startDate = "start_date"
        case targetDate = "target_date"
        case completedAt = "completed_at"
        case sortOrder = "sort_order"
        case parentIssueId = "parent_issue_id"
        case parentIssueSortOrder = "parent_issue_sort_order"
        case extensionMetadata = "extension_metadata"
        case creatorUserId = "creator_user_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

enum IssuePriority: String, Codable, CaseIterable, Hashable {
    case urgent, high, medium, low

    var label: String { rawValue.capitalized }
    /// SF Symbol used by the priority badge.
    var systemImage: String {
        switch self {
        case .urgent: return "exclamationmark.2"
        case .high: return "chevron.up"
        case .medium: return "equal"
        case .low: return "chevron.down"
        }
    }
}

// MARK: - Requests

/// `POST /v1/issues` body. Nullable-but-required fields are omitted when nil
/// (serde treats them as `None`); `extension_metadata` is always sent.
struct CreateIssueRequest: Codable {
    var id: String?
    let projectId: String
    let statusId: String
    let title: String
    var description: String?
    var priority: IssuePriority?
    var sortOrder: Double
    var extensionMetadata: JSONValue = .object([:])

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case statusId = "status_id"
        case title, description, priority
        case sortOrder = "sort_order"
        case extensionMetadata = "extension_metadata"
    }
}

/// Partial update; only present keys are changed (`PATCH /v1/issues/{id}`,
/// and flattened inside each bulk item).
struct UpdateIssueRequest: Codable {
    var statusId: String?
    var title: String?
    var description: String?
    var priority: IssuePriority?
    var sortOrder: Double?

    enum CodingKeys: String, CodingKey {
        case statusId = "status_id"
        case title, description, priority
        case sortOrder = "sort_order"
    }
}

/// `POST /v1/issues/bulk` — each item is an id plus flattened update fields.
struct BulkIssueItem: Codable {
    let id: String
    var statusId: String?
    var sortOrder: Double?
    var priority: IssuePriority?
    var title: String?

    enum CodingKeys: String, CodingKey {
        case id
        case statusId = "status_id"
        case sortOrder = "sort_order"
        case priority, title
    }
}

struct BulkIssuesRequest: Codable {
    let updates: [BulkIssueItem]
}

// MARK: - Read envelope

struct IssuesResponse: Codable { let issues: [Issue] }
