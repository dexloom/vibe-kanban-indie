import SwiftUI

/// The workspace / session window (analogue of `WorkspacesLayout`): a 3-pane
/// IDE-like layout — sessions + files | conversation + composer | inspector.
struct WorkspaceWindowView: View {
    let workspaceId: String?
    @Environment(AppState.self) private var app
    @State private var vm: WorkspaceViewModel?

    var body: some View {
        Group {
            if let vm {
                content(vm)
            } else if workspaceId == nil {
                TopPlaceholder("No workspace", systemImage: "cpu")
            } else {
                Loader(caption: "Loading workspace…")
            }
        }
        .navigationTitle(vm?.workspace?.displayName ?? "Workspace")
        .task(id: workspaceId) {
            guard let id = workspaceId, let client = app.client else { return }
            let model = WorkspaceViewModel(workspaceId: id, client: client)
            vm = model
            await model.load()
        }
        .onDisappear { vm?.teardown() }
    }

    @ViewBuilder
    private func content(_ vm: WorkspaceViewModel) -> some View {
        @Bindable var vm = vm
        HSplitView {
            // Left: sessions + files
            VStack(alignment: .leading, spacing: 12) {
                if !vm.sessions.isEmpty {
                    Picker("Session", selection: $vm.selectedSessionId) {
                        ForEach(vm.sessions) { Text($0.displayName).tag(Optional($0.id)) }
                    }
                    .pickerStyle(.menu)
                }
                if let exec = vm.activeExecution {
                    Label(exec.status.rawValue.capitalized,
                          systemImage: exec.status.isActive ? "play.circle" : "stop.circle")
                        .font(.caption)
                        .foregroundStyle(exec.status.isActive ? .green : .secondary)
                }
                Divider()
                FileTreeView(workspace: vm.workspace)
                Spacer()
            }
            .padding(10)
            .frame(minWidth: 180, idealWidth: 220, maxWidth: 300)

            // Center: conversation + approvals + composer
            VStack(spacing: 0) {
                ConversationListView(entries: vm.entries, streamConnected: vm.streamConnected)
                if !vm.pendingApprovals.isEmpty {
                    Divider()
                    VStack(spacing: 8) {
                        ForEach(vm.pendingApprovals) { approval in
                            ApprovalCardView(approval: approval) { outcome in
                                Task { await vm.respond(to: approval, outcome: outcome) }
                            }
                        }
                    }
                    .padding(10)
                }
                Divider()
                ChatInputView { prompt in
                    Task { await vm.sendFollowUp(prompt) }
                }
            }
            .frame(minWidth: 360)

            // Right: inspector
            RightInspector(rawLog: vm.rawLog, workspace: vm.workspace)
                .frame(minWidth: 260, idealWidth: 320, maxWidth: 460)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await vm.loadSession() } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
    }
}
