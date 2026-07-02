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

// MARK: - Executor / interactive derivation from `executor_action`
//
// `executor_action` mirrors Rust's `ExecutorAction { typ, next_action }`, where
// `typ` is an externally-tagged `ExecutorActionType` (`{"type": "...", ...}`).
// These port `packages/web-core/src/shared/lib/executor.ts` and `interactive.ts`.

extension ExecutionProcess {
    /// Walk this process's `executor_action` chain (`typ` → `next_action`) for
    /// the first coding-agent/review request's `executor_config`. Mirrors the
    /// web's `executorConfigFromAction`.
    var derivedExecutorConfig: ExecutorConfig? {
        Self.executorConfig(fromAction: executorAction)
    }

    private static func executorConfig(fromAction action: JSONValue?) -> ExecutorConfig? {
        guard let action, let typ = action["typ"] else { return nil }
        switch typ["type"]?.stringValue {
        case "CodingAgentInitialRequest", "CodingAgentFollowUpRequest", "ReviewRequest":
            guard let raw = typ["executor_config"],
                  let data = try? APICoding.encoder.encode(raw)
            else { return nil }
            return try? APICoding.decoder.decode(ExecutorConfig.self, from: data)
        default:
            return executorConfig(fromAction: action["next_action"])
        }
    }

    /// Whether this process's action carries a non-null `interactive` (detached
    /// tmux / "headed") config. Only coding-agent request types can be
    /// interactive — mirrors the web's `getInteractiveConfig`.
    var hasInteractiveConfig: Bool {
        guard let typ = executorAction?["typ"] else { return false }
        guard typ["type"]?.stringValue == "CodingAgentInitialRequest"
            || typ["type"]?.stringValue == "CodingAgentFollowUpRequest"
        else { return false }
        guard let interactive = typ["interactive"] else { return false }
        if case .null = interactive { return false }
        return true
    }

    /// A "live headed" process: a running coding-agent execution with an
    /// interactive (tmux) config — the gate for the Terminal pane's attach
    /// affordance. Mirrors the web's headed-live gate
    /// (`SessionChatBoxContainer.tsx`).
    var isLiveInteractiveCodingAgent: Bool {
        runReason == .codingagent && status == .running && hasInteractiveConfig
    }
}

/// Choose the `ExecutorConfig` to use for a session's next follow-up, mirroring
/// the web's precedence (`SessionChatBoxContainer.tsx` +
/// `getLatestConfigFromProcesses`): the session's own executions (newest
/// first) → the session's / a fallback session's `executor` field → `nil`
/// (callers use `.defaultConfig` only for a brand-new, executor-less session).
///
/// `executions` is expected oldest-first (as `GET /sessions/{id}/executions`
/// returns it); this scans newest-first internally.
func deriveExecutorConfig(
    executions: [ExecutionProcess],
    session: Session?,
    fallbackSessions: [Session]
) -> ExecutorConfig? {
    for execution in executions.reversed() {
        if let config = execution.derivedExecutorConfig { return config }
    }
    if let raw = session?.executor ?? fallbackSessions.first?.executor,
       let agent = BaseCodingAgent(rawValue: raw) {
        return ExecutorConfig(executor: agent)
    }
    return nil
}
