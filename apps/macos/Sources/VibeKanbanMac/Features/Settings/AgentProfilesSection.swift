import SwiftUI

/// Per-agent configuration editor (the macOS analogue of the web
/// `AgentsSettingsSection` + `ExecutorConfigForm`): pick an agent + variant,
/// edit its schema-driven config, create / delete variants, and save to
/// `/api/profiles`.
struct AgentProfilesSection: View {
    @Bindable var vm: SettingsViewModel

    @State private var agent: BaseCodingAgent = .claudeCode
    @State private var variant = "DEFAULT"
    @State private var working: [String: JSONValue] = [:]
    @State private var schema: ExecutorSchema?
    @State private var addingVariant = false
    @State private var loaded = false

    private var isDirty: Bool { working != vm.config(for: agent, variant: variant) }

    var body: some View {
        Section {
            Picker("Agent", selection: $agent) {
                ForEach(BaseCodingAgent.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .onChange(of: agent) { _, _ in syncSelection() }

            HStack {
                Picker("Configuration", selection: $variant) {
                    ForEach(vm.profileVariants(for: agent), id: \.self) { Text($0).tag($0) }
                }
                .onChange(of: variant) { _, _ in loadWorking() }
                Button { addingVariant = true } label: { Image(systemName: "plus") }
                    .help("New configuration")
                Button { Task { await deleteVariant() } } label: { Image(systemName: "trash") }
                    .help("Delete configuration")
                    .disabled(variant == "DEFAULT" || vm.profileVariants(for: agent).count <= 1)
            }

            if let schema {
                if schema.fields.isEmpty {
                    Text("This agent exposes no configurable options.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    AgentConfigForm(schema: schema, config: $working)
                }
            } else {
                Text("No config schema bundled for \(agent.label).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            HStack {
                Button("Save configuration") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isDirty || vm.profilesSaving)
                if vm.profilesSaving { ProgressView().controlSize(.small) }
                if isDirty { Text("Unsaved").font(.caption).foregroundStyle(.orange) }
                else if vm.profilesSaved { Text("Saved").font(.caption).foregroundStyle(.green) }
                if let err = vm.profilesError {
                    Text(err).font(.caption).foregroundStyle(.orange)
                }
            }
        } header: {
            Text("Agent configuration")
        } footer: {
            Text("Per-agent variants + options, saved to `/api/profiles`. Set the active default in the section above.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .task {
            guard !loaded else { return }
            loaded = true
            await vm.loadProfiles()
            agent = vm.defaultExecutor ?? .claudeCode
            syncSelection()
        }
        .sheet(isPresented: $addingVariant) {
            NewVariantSheet(existing: vm.profileVariants(for: agent)) { name in
                Task { await createVariant(name) }
            }
        }
    }

    private func syncSelection() {
        schema = ExecutorSchema.load(for: agent)
        let variants = vm.profileVariants(for: agent)
        if !variants.contains(variant) { variant = variants.first ?? "DEFAULT" }
        loadWorking()
    }

    private func loadWorking() {
        working = vm.config(for: agent, variant: variant)
    }

    private func save() async {
        vm.setConfig(working, for: agent, variant: variant)
        await vm.saveProfiles()
        loadWorking()
    }

    private func createVariant(_ name: String) async {
        vm.createVariant(name, for: agent)
        await vm.saveProfiles()
        variant = name
        loadWorking()
    }

    private func deleteVariant() async {
        let removed = variant
        vm.deleteVariant(removed, for: agent)
        await vm.saveProfiles()
        variant = vm.profileVariants(for: agent).first ?? "DEFAULT"
        loadWorking()
    }
}

private struct NewVariantSheet: View {
    let existing: [String]
    var onCreate: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    private var invalid: Bool {
        let t = name.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || existing.contains(t)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("New configuration").font(.headline)
            TextField("Name (e.g. PLAN, ROUTER)", text: $name).textFieldStyle(.roundedBorder)
            if existing.contains(name.trimmingCharacters(in: .whitespaces)) {
                Text("A configuration with that name already exists.")
                    .font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Create") {
                    onCreate(name.trimmingCharacters(in: .whitespaces)); dismiss()
                }
                .buttonStyle(.borderedProminent).disabled(invalid)
            }
        }
        .padding(18).frame(width: 320)
    }
}
