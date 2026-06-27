import SwiftUI

/// Preferences window (⌘,) — General / Agents / Editors / MCP / Data tabs.
struct SettingsView: View {
    @Environment(AppState.self) private var app
    @State private var vm = SettingsViewModel()

    var body: some View {
        TabView {
            GeneralSettings(vm: vm).tabItem { Label("General", systemImage: "gear") }
            AgentsSettings(vm: vm).tabItem { Label("Agents", systemImage: "cpu") }
            PlaceholderSettings(
                title: "Editors",
                note: "Editor availability via /editors/check-availability. (sketch)"
            ).tabItem { Label("Editors", systemImage: "chevron.left.forwardslash.chevron.right") }
            PlaceholderSettings(
                title: "MCP",
                note: "MCP servers via /mcp-config. (sketch)"
            ).tabItem { Label("MCP", systemImage: "puzzlepiece.extension") }
            PlaceholderSettings(
                title: "Data",
                note: "Import/export config via /import and /export. (sketch)"
            ).tabItem { Label("Data", systemImage: "tray.and.arrow.down") }
        }
        .frame(width: 520, height: 380)
        .task { await vm.load(client: app.client) }
    }
}

private struct GeneralSettings: View {
    @Environment(AppState.self) private var app
    @Bindable var vm: SettingsViewModel
    @AppStorage(BackendDiscovery.overrideKey) private var override = ""

    var body: some View {
        Form {
            Section("Backend connection") {
                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        Circle().fill(app.connection.isConnected ? .green : .orange).frame(width: 8, height: 8)
                        Text(app.connection.label)
                    }
                }
                LabeledContent("Base URL", value: app.baseURL?.absoluteString ?? "—")
                LabeledContent("Server version", value: vm.version ?? "—")
                LabeledContent("Environment", value: vm.environment ?? "—")
            }
            Section("Override") {
                TextField("Port or full URL", text: $override,
                          prompt: Text("e.g. 8080 or http://127.0.0.1:8080"))
                Text("Leave blank to auto-discover from $TMPDIR/vibe-kanban/vibe-kanban.port.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Reconnect") {
                    Task { await app.bootstrap(); await vm.load(client: app.client) }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct AgentsSettings: View {
    @Bindable var vm: SettingsViewModel

    var body: some View {
        Form {
            Section {
                ForEach(BaseCodingAgent.allCases, id: \.self) { agent in
                    LabeledContent(agent.label) {
                        availability(for: vm.agents[agent])
                    }
                }
            } header: {
                HStack {
                    Text("Coding agents")
                    Spacer()
                    if vm.isLoading { ProgressView().controlSize(.small) }
                }
            } footer: {
                Text("Availability from /agents/check-availability.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    @ViewBuilder
    private func availability(for info: AvailabilityInfo?) -> some View {
        if let info {
            Label(info.label, systemImage: info.available ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundStyle(info.available ? .green : .secondary)
                .labelStyle(.titleAndIcon)
        } else {
            Text("—").foregroundStyle(.tertiary)
        }
    }
}

private struct PlaceholderSettings: View {
    let title: String
    let note: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "wrench.and.screwdriver").font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(note).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
