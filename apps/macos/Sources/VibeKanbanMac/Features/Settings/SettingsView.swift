import SwiftUI

/// Preferences window (⌘,) — General / Agents / Editors / MCP / Data tabs.
struct SettingsView: View {
    @Environment(AppState.self) private var app
    @State private var vm = SettingsViewModel()

    var body: some View {
        TabView {
            GeneralSettings(vm: vm).tabItem { Label("General", systemImage: "gear") }
            BackendSettings().tabItem { Label("Backend", systemImage: "server.rack") }
            AgentsSettings(vm: vm).tabItem { Label("Agents", systemImage: "cpu") }
            ProjectsSettingsView().tabItem { Label("Projects", systemImage: "rectangle.stack") }
            RepositoriesSettingsView().tabItem { Label("Repositories", systemImage: "folder") }
            PlaceholderSettings(
                title: "MCP",
                note: "MCP servers via /mcp-config. (sketch)"
            ).tabItem { Label("MCP", systemImage: "puzzlepiece.extension") }
            PlaceholderSettings(
                title: "Data",
                note: "Import/export config via /import and /export. (sketch)"
            ).tabItem { Label("Data", systemImage: "tray.and.arrow.down") }
        }
        .frame(width: 620, height: 460)
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
    @State private var profilesExpanded = false

    var body: some View {
        Form {
            defaultAgentSection
            availabilitySection
            profilesSection
        }
        .formStyle(.grouped)
        .padding()
    }

    @ViewBuilder
    private var defaultAgentSection: some View {
        Section {
            Picker("Default agent", selection: $vm.defaultExecutor) {
                Text("Select…").tag(BaseCodingAgent?.none)
                ForEach(BaseCodingAgent.allCases, id: \.self) { agent in
                    Text(agent.label).tag(BaseCodingAgent?.some(agent))
                }
            }
            .onChange(of: vm.defaultExecutor) { _, exec in
                if let exec, !vm.variants(for: exec).contains(vm.defaultVariant) {
                    vm.defaultVariant = vm.variants(for: exec).first ?? "DEFAULT"
                }
            }
            if let exec = vm.defaultExecutor {
                Picker("Variant", selection: $vm.defaultVariant) {
                    ForEach(vm.variants(for: exec), id: \.self) { Text($0).tag($0) }
                }
            }
            HStack {
                Button("Apply default") { Task { await vm.saveDefaultAgent() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.defaultExecutor == nil || vm.savingAgent)
                if vm.savingAgent { ProgressView().controlSize(.small) }
                if let err = vm.agentSaveError {
                    Text(err).font(.caption).foregroundStyle(.orange)
                }
            }
        } header: {
            Text("Default agent")
        } footer: {
            Text("Saved to the backend (`config.executor_profile`) — the agent the orchestrator runs by default.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var availabilitySection: some View {
        Section {
            ForEach(BaseCodingAgent.allCases, id: \.self) { agent in
                LabeledContent(agent.label) {
                    availability(for: vm.agents[agent])
                }
            }
        } header: {
            HStack {
                Text("Availability")
                Spacer()
                if vm.isLoading { ProgressView().controlSize(.small) }
                Button { Task { await vm.load(client: vm.lastClient) } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
        } footer: {
            Text("Availability from /agents/check-availability.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var profilesSection: some View {
        Section {
            DisclosureGroup("Executor profiles (advanced JSON)", isExpanded: $profilesExpanded) {
                TextEditor(text: $vm.profilesText)
                    .font(.system(.caption, design: .monospaced))
                    .frame(minHeight: 140)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
                HStack {
                    Button("Reload") { Task { await vm.loadProfiles() } }
                    Button("Save profiles") { Task { await vm.saveProfiles() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(vm.profilesSaving)
                    if vm.profilesSaving { ProgressView().controlSize(.small) }
                    if vm.profilesSaved { Text("Saved").font(.caption).foregroundStyle(.green) }
                    if let err = vm.profilesError {
                        Text(err).font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            .onChange(of: profilesExpanded) { _, open in
                if open, vm.profilesText.isEmpty { Task { await vm.loadProfiles() } }
            }
        } footer: {
            Text("Raw `/profiles` JSON: per-agent variants and options (effort, models, append-prompt, …).")
                .font(.caption).foregroundStyle(.secondary)
        }
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

private struct BackendSettings: View {
    @Environment(AppState.self) private var app
    @AppStorage(BackendManager.modeKey) private var mode: BackendMode = .managed
    @AppStorage(BackendManager.exePathKey) private var exePath = ""
    @AppStorage(BackendManager.repoPathKey) private var repoPath = ""
    @AppStorage(BackendManager.buildFromSourceKey) private var buildFromSource = false

    var body: some View {
        Form {
            Section("Mode") {
                Picker("Backend", selection: $mode) {
                    ForEach(BackendMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.radioGroup)
                Text(mode == .managed
                     ? "The app launches and supervises its own `server` process."
                     : "You run the server yourself (e.g. `pnpm run dev`); the app just connects.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            if mode == .managed {
                Section("Server binary") {
                    TextField("Executable path", text: $exePath,
                              prompt: Text("/path/to/target/release/server (optional)"))
                    TextField("Repo path", text: $repoPath,
                              prompt: Text("/path/to/vibe-kanban-indie (to find target/{release,debug}/server)"))
                    Toggle("Build from source with cargo if no binary is found", isOn: $buildFromSource)
                    Text("Resolution order: bundled binary → executable path → <repo>/target/release/server → debug.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Status") {
                LabeledContent("Connection", value: app.connection.label)
                LabeledContent("Backend", value: app.backend.state.label)
                HStack {
                    Button("Apply & reconnect") { Task { await app.restartManagedBackend() } }
                        .buttonStyle(.borderedProminent)
                    Button("Stop") { app.backend.stop() }
                }
            }

            if !app.backend.log.isEmpty {
                Section("Log") {
                    ScrollView {
                        Text(app.backend.log)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 120)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct PlaceholderSettings: View {
    let title: String
    let note: String
    var body: some View {
        TopPlaceholder(title, systemImage: "wrench.and.screwdriver", description: note)
            .padding()
    }
}
