import Foundation

/// One agent/script run inside a session. Mirrors `shared/types.ts`
/// `ExecutionProcess`; served by `/execution-processes/{id}` and
/// `/sessions/{id}/executions`.
struct ExecutionProcess: Codable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let runReason: ExecutionProcessRunReason
    let executorAction: JSONValue?
    var status: ExecutionProcessStatus
    let exitCode: Int64?
    var dropped: Bool
    let startedAt: Date
    var completedAt: Date?
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case runReason = "run_reason"
        case executorAction = "executor_action"
        case status
        case exitCode = "exit_code"
        case dropped
        case startedAt = "started_at"
        case completedAt = "completed_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

enum ExecutionProcessStatus: String, Codable, Hashable {
    case running, completed, failed, killed

    var isActive: Bool { self == .running }
}

enum ExecutionProcessRunReason: String, Codable, Hashable {
    case setupscript, cleanupscript, archivescript, codingagent, devserver
}

/// `GET /execution-processes/{id}/agent-progress` — latest agent message
/// (polling fallback for the normalized-log stream).
struct AgentProgress: Codable {
    let content: String?
    let timestamp: Date?
}

struct ExecutionsResponse: Codable { let executions: [ExecutionProcess]? }
