import Foundation

/// A registered git repository (`/api/repos`, and `/v1/projects/{id}/repos` for
/// the ones linked to a project). Mirrors `shared/types.ts` `Repo` / the Rust
/// `db::models::repo::Repo`. Used to mount repos for spec generation / workspace
/// start and to drive the Repositories settings tab.
struct Repo: Codable, Identifiable, Hashable {
    let id: String
    var path: String
    let name: String
    var displayName: String
    var setupScript: String?
    var cleanupScript: String?
    var archiveScript: String?
    var devServerScript: String?
    var defaultTargetBranch: String?
    var defaultWorkingDir: String?
    let createdAt: Date?
    let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, path, name
        case displayName = "display_name"
        case setupScript = "setup_script"
        case cleanupScript = "cleanup_script"
        case archiveScript = "archive_script"
        case devServerScript = "dev_server_script"
        case defaultTargetBranch = "default_target_branch"
        case defaultWorkingDir = "default_working_dir"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct ReposResponse: Codable { let repos: [Repo] }

/// `POST /spec/generate` body. Mirrors `GenerateSpecRequest`.
struct GenerateSpecRequest: Codable {
    let projectId: String
    let brief: String
    let executorConfig: ExecutorConfig
    let repos: [WorkspaceRepoInput]

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case brief
        case executorConfig = "executor_config"
        case repos
    }
}

/// `ApiResponse<GenerateSpecResponse>` payload. `intakeMetadata` is the
/// `{ "intake": {...} }` object to drop verbatim into `extension_metadata`.
struct GenerateSpecResponse: Codable {
    let title: String
    let description: String
    let intakeMetadata: JSONValue

    enum CodingKeys: String, CodingKey {
        case title, description
        case intakeMetadata = "intake_metadata"
    }
}
