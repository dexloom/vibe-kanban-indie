import Foundation

/// A repo linked to a project (`/v1/projects/{id}/repos`). Used to mount repos
/// for spec generation / workspace start. Mirrors `shared/types.ts` `Repo`.
struct Repo: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let displayName: String?
    let defaultTargetBranch: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case displayName = "display_name"
        case defaultTargetBranch = "default_target_branch"
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
