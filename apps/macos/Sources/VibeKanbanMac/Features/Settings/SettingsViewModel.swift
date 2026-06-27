import Foundation
import Observation

/// Loads live system info + agent availability for the Settings window.
@MainActor
@Observable
final class SettingsViewModel {
    var version: String?
    var machineId: String?
    var environment: String?
    var agents: [BaseCodingAgent: AvailabilityInfo] = [:]
    var isLoading = false
    var error: String?

    /// Remembered so the Agents tab's refresh button can reload without re-plumbing.
    private(set) var lastClient: APIClient?

    func load(client: APIClient?) async {
        guard let client else { return }
        lastClient = client
        isLoading = true
        defer { isLoading = false }

        if let info = try? await client.systemInfo(), case let .object(obj) = info {
            version = obj["version"]?.displayString
            machineId = obj["machine_id"]?.displayString
            environment = obj["environment"]?.displayString
        }

        var found: [BaseCodingAgent: AvailabilityInfo] = [:]
        for agent in BaseCodingAgent.allCases {
            if let info = try? await client.agentAvailability(agent) {
                found[agent] = info
            }
        }
        agents = found
    }
}
