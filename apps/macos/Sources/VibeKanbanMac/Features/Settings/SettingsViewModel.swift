import Foundation
import Observation

/// Loads live system info, the editable backend config (default agent), agent
/// availability, and the structured executor **profiles** (per-agent variants +
/// config) for the Settings window.
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
    private(set) var config: JSONValue?
    var defaultExecutor: BaseCodingAgent?
    var defaultVariant: String = "DEFAULT"
    private(set) var variantsByExecutor: [BaseCodingAgent: [String]] = [:]
    var savingAgent = false
    var agentSaveError: String?

    // Executor profiles (`/api/profiles`) — the per-agent variant configs.
    private(set) var profilesRoot: JSONValue?
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
        var variants: [BaseCodingAgent: [String]] = [:]
        if let execs = info["executors"]?.objectValue {
            for (key, value) in execs {
                guard let agent = BaseCodingAgent(rawValue: key),
                      let inner = value.objectValue else { continue }
                variants[agent] = inner.keys.filter { $0 != "recently_used_models" }.sorted()
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

    // MARK: - Executor profiles (per-agent variant configs)

    func loadProfiles() async {
        guard let client = lastClient else { return }
        do {
            let text = try await client.profilesContent()
            profilesRoot = (try? APICoding.decoder.decode(JSONValue.self, from: Data(text.utf8))) ?? .object([:])
            profilesError = nil
        } catch {
            profilesError = error.localizedDescription
        }
    }

    /// Variant names defined for an executor in the profiles (excludes the
    /// `recently_used_models` meta entry). Always includes at least DEFAULT.
    func profileVariants(for executor: BaseCodingAgent) -> [String] {
        let inner = profilesRoot?.value(at: ["executors", executor.rawValue])?.objectValue ?? [:]
        let names = inner.keys.filter { $0 != "recently_used_models" }.sorted()
        return names.isEmpty ? ["DEFAULT"] : names
    }

    /// The config object for one (executor, variant): `executors[E][V][E]`.
    func config(for executor: BaseCodingAgent, variant: String) -> [String: JSONValue] {
        profilesRoot?.value(at: ["executors", executor.rawValue, variant, executor.rawValue])?
            .objectValue ?? [:]
    }

    func setConfig(_ config: [String: JSONValue], for executor: BaseCodingAgent, variant: String) {
        let root = profilesRoot ?? .object([:])
        profilesRoot = root.setting(
            ["executors", executor.rawValue, variant, executor.rawValue], to: .object(config))
    }

    func createVariant(_ name: String, for executor: BaseCodingAgent) {
        let root = profilesRoot ?? .object([:])
        profilesRoot = root.setting(
            ["executors", executor.rawValue, name, executor.rawValue], to: .object([:]))
    }

    func deleteVariant(_ name: String, for executor: BaseCodingAgent) {
        guard let root = profilesRoot else { return }
        profilesRoot = root.setting(["executors", executor.rawValue, name], to: nil)
    }

    /// Serialize the profiles tree and PUT it to `/api/profiles`.
    func saveProfiles() async {
        guard let client = lastClient, let root = profilesRoot else { return }
        profilesSaving = true; profilesSaved = false
        defer { profilesSaving = false }
        do {
            let data = try APICoding.encoder.encode(root)
            let text = String(data: data, encoding: .utf8) ?? "{}"
            try await client.updateProfiles(text)
            profilesError = nil
            profilesSaved = true
            await load(client: client)   // refresh variant lists / default picker
            await loadProfiles()
        } catch {
            profilesError = error.localizedDescription
        }
    }
}
