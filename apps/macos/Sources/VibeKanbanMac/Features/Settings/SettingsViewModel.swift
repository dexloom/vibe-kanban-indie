import Foundation
import Observation

/// Loads live system info, the editable backend config (default agent), agent
/// availability, and the raw executor-profiles JSON for the Settings window.
@MainActor
@Observable
final class SettingsViewModel {
    var version: String?
    var machineId: String?
    var environment: String?
    var agents: [BaseCodingAgent: AvailabilityInfo] = [:]
    var isLoading = false
    var error: String?

    // Default agent — the backend `config.executor_profile`, edited via PUT /config.
    /// The full config object, round-tripped on save.
    private(set) var config: JSONValue?
    var defaultExecutor: BaseCodingAgent?
    var defaultVariant: String = "DEFAULT"
    private(set) var variantsByExecutor: [BaseCodingAgent: [String]] = [:]
    var savingAgent = false
    var agentSaveError: String?

    // Advanced: the raw executor-profiles JSON (`/api/profiles`).
    var profilesText: String = ""
    var profilesSaving = false
    var profilesError: String?
    var profilesSaved = false

    /// Remembered so the Agents tab can reload without re-plumbing the client.
    private(set) var lastClient: APIClient?

    func variants(for executor: BaseCodingAgent) -> [String] {
        let v = variantsByExecutor[executor] ?? []
        return v.isEmpty ? ["DEFAULT"] : v
    }

    func load(client: APIClient?) async {
        guard let client else { return }
        lastClient = client
        isLoading = true
        defer { isLoading = false }

        if let info = try? await client.systemInfo(), case .object = info {
            version = info["version"]?.displayString
            machineId = info["machine_id"]?.displayString
            environment = info["environment"]?.displayString
            parseConfig(from: info)
        }

        var found: [BaseCodingAgent: AvailabilityInfo] = [:]
        for agent in BaseCodingAgent.allCases {
            if let info = try? await client.agentAvailability(agent) {
                found[agent] = info
            }
        }
        agents = found
    }

    private func parseConfig(from info: JSONValue) {
        config = info["config"]
        if let profile = config?["executor_profile"] {
            defaultExecutor = profile["executor"]?.stringValue.flatMap(BaseCodingAgent.init(rawValue:))
            defaultVariant = profile["variant"]?.stringValue ?? "DEFAULT"
        }
        // `executors` is the flattened profiles map: { AGENT: { VARIANT: {...}, "recently_used_models": {...} } }
        var variants: [BaseCodingAgent: [String]] = [:]
        if let execs = info["executors"]?.objectValue {
            for (key, value) in execs {
                guard let agent = BaseCodingAgent(rawValue: key),
                      let inner = value.objectValue else { continue }
                let keys = inner.keys.filter { $0 != "recently_used_models" }.sorted()
                variants[agent] = keys
            }
        }
        variantsByExecutor = variants
    }

    /// Persist the default agent (executor + variant) into `config.executor_profile`.
    func saveDefaultAgent() async {
        guard let client = lastClient, let executor = defaultExecutor,
              let configObject = config?.objectValue else {
            agentSaveError = "No config loaded."
            return
        }
        savingAgent = true
        defer { savingAgent = false }

        var newConfig = configObject
        var profile: [String: JSONValue] = ["executor": .string(executor.rawValue)]
        if !defaultVariant.isEmpty { profile["variant"] = .string(defaultVariant) }
        newConfig["executor_profile"] = .object(profile)

        do {
            try await client.updateConfig(.object(newConfig))
            config = .object(newConfig)
            agentSaveError = nil
        } catch {
            agentSaveError = error.localizedDescription
        }
    }

    // MARK: - Raw profiles editing

    func loadProfiles() async {
        guard let client = lastClient else { return }
        do { profilesText = try await client.profilesContent(); profilesError = nil }
        catch { profilesError = error.localizedDescription }
    }

    func saveProfiles() async {
        guard let client = lastClient else { return }
        profilesSaving = true; profilesSaved = false
        defer { profilesSaving = false }
        do {
            try await client.updateProfiles(profilesText)
            profilesError = nil
            profilesSaved = true
            // Reload so variant lists reflect any new variants.
            await load(client: client)
        } catch {
            profilesError = error.localizedDescription
        }
    }
}
