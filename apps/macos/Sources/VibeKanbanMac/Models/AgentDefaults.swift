import Foundation

/// Locally-stored defaults for the coding agent (executor) used to pre-fill the
/// card composer. Persisted in `UserDefaults` and edited in Settings → Agents.
/// These are client preferences, not backend config.
enum AgentDefaults {
    /// Raw value of the default `BaseCodingAgent` ("" = let the orchestrator pick).
    static let executorKey = "defaultExecutor"
    /// Default model id override ("" = the agent's own default).
    static let modelKey = "defaultModelId"

    /// The configured default executor, or nil to defer to the orchestrator.
    static var executor: BaseCodingAgent? {
        let raw = UserDefaults.standard.string(forKey: executorKey) ?? ""
        return raw.isEmpty ? nil : BaseCodingAgent(rawValue: raw)
    }

    static var modelId: String {
        UserDefaults.standard.string(forKey: modelKey) ?? ""
    }
}
