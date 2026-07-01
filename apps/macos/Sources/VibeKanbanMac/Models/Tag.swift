import Foundation

/// A label. Mirrors `remote-types.ts` `Tag`; served by `/v1/fallback/tags`.
struct Tag: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    var name: String
    var color: String

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case name, color
    }
}

/// Many-to-many issue↔tag link.
struct IssueTag: Codable, Identifiable, Hashable {
    let id: String
    let issueId: String
    let tagId: String

    enum CodingKeys: String, CodingKey {
        case id
        case issueId = "issue_id"
        case tagId = "tag_id"
    }
}

/// Many-to-many issue↔user assignment.
struct IssueAssignee: Codable, Identifiable, Hashable {
    let id: String
    let issueId: String
    let userId: String
    let assignedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case issueId = "issue_id"
        case userId = "user_id"
        case assignedAt = "assigned_at"
    }
}

struct IssueRelationship: Codable, Identifiable, Hashable {
    let id: String
    let issueId: String
    let relatedIssueId: String
    let relationshipType: IssueRelationshipType
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case issueId = "issue_id"
        case relatedIssueId = "related_issue_id"
        case relationshipType = "relationship_type"
        case createdAt = "created_at"
    }
}

enum IssueRelationshipType: String, Codable, Hashable {
    case blocking, related
    case hasDuplicate = "has_duplicate"
}

struct IssueComment: Codable, Identifiable, Hashable {
    let id: String
    let issueId: String
    let authorId: String?
    let parentId: String?
    var message: String
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case issueId = "issue_id"
        case authorId = "author_id"
        case parentId = "parent_id"
        case message
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct PullRequest: Codable, Identifiable, Hashable {
    let id: String
    let url: String
    let number: Int
    let status: PullRequestStatus
    let targetBranchName: String
    let projectId: String
    let issueId: String
    let workspaceId: String?
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, url, number, status
        case targetBranchName = "target_branch_name"
        case projectId = "project_id"
        case issueId = "issue_id"
        case workspaceId = "workspace_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

enum PullRequestStatus: String, Codable, Hashable {
    case open, merged, closed
}

// MARK: - Read envelopes

struct TagsResponse: Codable { let tags: [Tag] }
struct IssueTagsResponse: Codable { let issue_tags: [IssueTag] }
struct IssueAssigneesResponse: Codable { let issue_assignees: [IssueAssignee] }
