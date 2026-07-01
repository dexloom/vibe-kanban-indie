import SwiftUI

/// Loads Voicy's installed agents (over IPC) for the situation→agent pickers.
@MainActor
@Observable
final class VoiceSettingsModel {
    var agents: [VoicyAgent] = []
    var loadError: String?
    var isLoading = false

    private let client = VoicyClient()

    func load() async {
        isLoading = true
        loadError = nil
        do {
            agents = try await client.listAgents()
        } catch {
            agents = []
            loadError = error.localizedDescription
        }
        isLoading = false
    }
}

/// Settings → Voice: map each dictation situation to the Voicy agent that should
/// prepare it. Only agent-surface situations have an agent (task → Task composer).
struct VoiceSettingsView: View {
    @State private var model = VoiceSettingsModel()

    private var agentSituations: [DictationSituation] {
        DictationSituation.allCases.filter { $0.mode == .agent }
    }

    var body: some View {
        Form {
            Section {
                ForEach(agentSituations) { situation in
                    Picker(situation.title, selection: agentBinding(situation)) {
                        Text("Voicy's active agent").tag("")
                        ForEach(model.agents) { agent in
                            Text(agent.name).tag(agent.id)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Agent for each situation")
                    Spacer()
                    if model.isLoading { ProgressView().controlSize(.small) }
                    Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                }
            } footer: {
                footer
            }
        }
        .formStyle(.grouped)
        .padding()
        .task { await model.load() }
    }

    @ViewBuilder
    private var footer: some View {
        if let error = model.loadError {
            Text("Couldn't load Voicy's agents (\(error)). Open Voicy, then Reload.")
                .font(.caption).foregroundStyle(.orange)
        } else if model.agents.isEmpty {
            Text("No Voicy agents found. Add agents in Voicy (~/.voicy/agents), then Reload.")
                .font(.caption).foregroundStyle(.secondary)
        } else {
            Text("The mic picks the agent from the situation you choose. “Task” opens Voicy's Task composer (no agent).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Reads/writes the persisted mapping for `situation`. The empty tag means
    /// "use Voicy's active agent".
    private func agentBinding(_ situation: DictationSituation) -> Binding<String> {
        Binding(
            get: { VoiceAgentMap.agentId(for: situation) ?? "" },
            set: { VoiceAgentMap.setAgentId($0.isEmpty ? nil : $0, for: situation) }
        )
    }
}
