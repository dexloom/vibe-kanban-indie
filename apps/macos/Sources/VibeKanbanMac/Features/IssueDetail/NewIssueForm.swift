import SwiftUI

/// Full card-creation composer shown in the inspector (right pane), mirroring the
/// web flow: basic fields + agent selection + pipeline stages + spec generation.
struct IssueComposerView: View {
    @Bindable var model: IssueComposerModel
    var onCancel: () -> Void
    var onCreate: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("New issue").font(.title3.weight(.semibold))
                Divider()
                basics
                Divider()
                intakeSection
                Divider()
                pipelineSection
                Divider()
                actions
            }
            .padding(16)
        }
    }

    // MARK: - Basics

    private var basics: some View {
        VStack(alignment: .leading, spacing: 10) {
            field("Title") {
                TextField("Issue title", text: $model.title, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 12) {
                field("Status") {
                    Picker("Status", selection: $model.statusId) {
                        ForEach(model.statuses) { Text($0.name).tag($0.id) }
                    }.labelsHidden()
                }
                field("Priority") {
                    Picker("Priority", selection: $model.priority) {
                        Text("None").tag(IssuePriority?.none)
                        ForEach(IssuePriority.allCases, id: \.self) { p in
                            Text(p.label).tag(IssuePriority?.some(p))
                        }
                    }.labelsHidden()
                }
            }
            field("Description") {
                TextEditor(text: $model.descriptionText)
                    .font(.body)
                    .frame(minHeight: 110)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            }
        }
    }

    // MARK: - Intake / Spec

    private var intakeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Spec", systemImage: "sparkles").font(.headline)
            Text("Expand the brief above into a development-ready spec using the selected agent.")
                .font(.caption).foregroundStyle(.secondary)

            agentPicker

            HStack {
                Button {
                    Task { await model.generateSpec() }
                } label: {
                    if model.isGeneratingSpec {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Generating spec…") }
                    } else {
                        Label("Generate spec", systemImage: "wand.and.stars")
                    }
                }
                .disabled(model.isGeneratingSpec)
            }
            if let error = model.specError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private var agentPicker: some View {
        HStack(spacing: 12) {
            field("Agent") {
                Picker("Agent", selection: $model.executor) {
                    Text("Default").tag(BaseCodingAgent?.none)
                    ForEach(BaseCodingAgent.allCases, id: \.self) { agent in
                        Text(agent.label).tag(BaseCodingAgent?.some(agent))
                    }
                }.labelsHidden()
            }
            field("Model (optional)") {
                TextField("e.g. anthropic/claude-sonnet-4", text: $model.modelId)
                    .textFieldStyle(.roundedBorder)
            }
        }
    }

    // MARK: - Pipeline

    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Pipeline", systemImage: "slider.horizontal.3").font(.headline)
            Text("Stages to run for this card. The pinned agent + ticked stages are written into the description as a `## Pipeline` block.")
                .font(.caption).foregroundStyle(.secondary)

            ForEach(model.steps) { step in
                Toggle(isOn: binding(for: step)) {
                    Text(step.label)
                }
                .toggleStyle(.checkbox)
                .help(step.promptFragment)
            }

            field("Custom instructions (optional)") {
                TextEditor(text: $model.customText)
                    .font(.callout)
                    .frame(minHeight: 60)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            }
        }
    }

    private func binding(for step: PipelineStep) -> Binding<Bool> {
        Binding(
            get: { model.enabledStepIds.contains(step.id) },
            set: { on in
                if on { model.enabledStepIds.insert(step.id) } else { model.enabledStepIds.remove(step.id) }
            }
        )
    }

    // MARK: - Actions

    private var actions: some View {
        HStack {
            Button("Cancel", role: .cancel) { onCancel() }
            Spacer()
            Button("Create issue") { onCreate() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!model.canSubmit)
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.medium))
            content()
        }
    }
}
