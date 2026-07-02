import Foundation

/// A coding-agent conversation within a workspace. Mirrors `shared/types.ts`
/// `Session`; served by `/sessions?workspace_id=`.
struct Session: Codable, Identifiable, Hashable {
    let id: String
    let workspaceId: String
    var name: String?
    var executor: String?
    var agentWorkingDir: String?
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId = "workspace_id"
        case name, executor
        case agentWorkingDir = "agent_working_dir"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    var displayName: String { name ?? "Session \(id.prefix(6))" }
}

/// `POST /sessions/{id}/follow-up` body.
struct CreateFollowUpAttempt: Codable {
    let prompt: String
    let executorConfig: ExecutorConfig
    var retryProcessId: String? = nil
    var forceWhenDirty: Bool? = nil
    var performGitReset: Bool? = nil

    enum CodingKeys: String, CodingKey {
        case prompt
        case executorConfig = "executor_config"
        case retryProcessId = "retry_process_id"
        case forceWhenDirty = "force_when_dirty"
        case performGitReset = "perform_git_reset"
    }
}

/// `POST /sessions` body. Mirrors `CreateSessionRequest` in
/// `crates/server/src/routes/sessions/mod.rs`.
struct CreateSessionRequest: Codable {
    let workspaceId: String
    var executor: String? = nil
    var name: String? = nil

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id"
        case executor, name
    }
}

/// `PUT /sessions/{id}` body. Mirrors `db::models::requests::UpdateSession`.
struct UpdateSessionRequest: Codable {
    let name: String?
}

/// `POST /execution-processes/{id}/send-input` body. Mirrors `SendInputBody`
/// in `crates/server/src/routes/execution_processes.rs`.
struct SendInputRequest: Codable {
    let text: String
}
