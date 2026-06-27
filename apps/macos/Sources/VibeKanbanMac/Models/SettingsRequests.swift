import Foundation

// Request/response bodies for the Projects, Repositories, and project↔repo
// linking endpoints driven by the Settings window.

// MARK: - Projects (`/v1/projects`, MutationResponse `{ data, txid }`)

/// `POST /v1/projects`. `organizationId` is the single local org; `id` lets us
/// use a client-generated id for optimistic updates (we let the server assign).
struct CreateProjectRequest: Codable {
    var id: String?
    let organizationId: String
    let name: String
    let color: String

    enum CodingKeys: String, CodingKey {
        case id
        case organizationId = "organization_id"
        case name, color
    }
}

/// `PATCH /v1/projects/{id}`. Nil fields are omitted (left unchanged).
struct UpdateProjectRequest: Codable {
    var name: String?
    var color: String?
    var sortOrder: Int?

    enum CodingKeys: String, CodingKey {
        case name, color
        case sortOrder = "sort_order"
    }
}

// MARK: - Repositories (`/api/repos`, ApiResponse `{ success, data, … }`)

/// `POST /api/repos` — register an existing git checkout by path.
struct RegisterRepoRequest: Codable {
    let path: String
    var displayName: String?

    enum CodingKeys: String, CodingKey {
        case path
        case displayName = "display_name"
    }
}

/// `PUT /api/repos/{id}`. Nil fields are omitted (left unchanged). The backend
/// uses double-option semantics, so an omitted key is "no change"; we only send
/// the fields the user edited.
struct UpdateRepoRequest: Codable {
    var displayName: String?
    var setupScript: String?
    var cleanupScript: String?
    var devServerScript: String?
    var defaultTargetBranch: String?
    var defaultWorkingDir: String?

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case setupScript = "setup_script"
        case cleanupScript = "cleanup_script"
        case devServerScript = "dev_server_script"
        case defaultTargetBranch = "default_target_branch"
        case defaultWorkingDir = "default_working_dir"
    }
}

// MARK: - Project ↔ repo links (`/v1/projects/{id}/repos`)

/// `POST /v1/projects/{id}/repos` — link an existing repo to a project.
struct LinkRepoRequest: Codable {
    let repoId: String

    enum CodingKeys: String, CodingKey {
        case repoId = "repo_id"
    }
}

// MARK: - Well-known local ids

enum LocalIds {
    /// The single synthetic local organization (`Uuid::from_u128(0xA001)` in
    /// `crates/db/src/models/project.rs`). Used when creating the first project,
    /// before any existing project's `organization_id` is available to reuse.
    static let organizationId = "00000000-0000-0000-0000-00000000a001"
}
