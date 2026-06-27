import Foundation

/// Supported coding agents. Mirrors `shared/types.ts` `BaseCodingAgent`.
enum BaseCodingAgent: String, Codable, CaseIterable, Hashable {
    case claudeCode = "CLAUDE_CODE"
    case claudeCodeHeaded = "CLAUDE_CODE_HEADED"
    case amp = "AMP"
    case gemini = "GEMINI"
    case codex = "CODEX"
    case opencode = "OPENCODE"
    case cursorAgent = "CURSOR_AGENT"
    case qwenCode = "QWEN_CODE"
    case copilot = "COPILOT"
    case droid = "DROID"

    var label: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .claudeCodeHeaded: return "Claude Code (headed)"
        case .amp: return "Amp"
        case .gemini: return "Gemini"
        case .codex: return "Codex"
        case .opencode: return "OpenCode"
        case .cursorAgent: return "Cursor Agent"
        case .qwenCode: return "Qwen Code"
        case .copilot: return "Copilot"
        case .droid: return "Droid"
        }
    }
}

enum PermissionPolicy: String, Codable, CaseIterable, Hashable {
    case auto = "AUTO"
    case supervised = "SUPERVISED"
    case plan = "PLAN"
}

/// Unified executor identity + overrides. Mirrors `shared/types.ts`
/// `ExecutorConfig`.
struct ExecutorConfig: Codable, Hashable {
    var executor: BaseCodingAgent
    var variant: String?
    var modelId: String?
    var agentId: String?
    var reasoningId: String?
    var permissionPolicy: PermissionPolicy?

    enum CodingKeys: String, CodingKey {
        case executor, variant
        case modelId = "model_id"
        case agentId = "agent_id"
        case reasoningId = "reasoning_id"
        case permissionPolicy = "permission_policy"
    }

    static let defaultConfig = ExecutorConfig(executor: .claudeCode)
}

struct WorkspaceRepoInput: Codable, Hashable {
    let repoId: String
    let targetBranch: String

    enum CodingKeys: String, CodingKey {
        case repoId = "repo_id"
        case targetBranch = "target_branch"
    }
}

struct LinkedIssueInfo: Codable, Hashable {
    let remoteProjectId: String
    let issueId: String

    enum CodingKeys: String, CodingKey {
        case remoteProjectId = "remote_project_id"
        case issueId = "issue_id"
    }
}

/// `POST /workspaces/start` body.
struct CreateAndStartWorkspaceRequest: Codable {
    var name: String?
    var repos: [WorkspaceRepoInput]
    var linkedIssue: LinkedIssueInfo?
    var executorConfig: ExecutorConfig
    var prompt: String
    var attachmentIds: [String]?

    enum CodingKeys: String, CodingKey {
        case name, repos
        case linkedIssue = "linked_issue"
        case executorConfig = "executor_config"
        case prompt
        case attachmentIds = "attachment_ids"
    }
}

struct CreateAndStartWorkspaceResponse: Codable {
    let workspace: Workspace
    let executionProcess: ExecutionProcess

    enum CodingKeys: String, CodingKey {
        case workspace
        case executionProcess = "execution_process"
    }
}
