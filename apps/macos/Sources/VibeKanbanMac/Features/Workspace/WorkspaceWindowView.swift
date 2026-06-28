import SwiftUI

/// Which view the main workspace pane shows. `agent` is the conversation +
/// composer; the rest mirror the old right-inspector tabs.
private enum WorkspacePane: String, CaseIterable, Identifiable {
    case agent, terminal, logs, changes, preview
    var id: String { rawValue }
    var title: String {
        switch self {
        case .agent:    return "Agent"
        case .terminal: return "Terminal"
        case .logs:     return "Logs"
        case .changes:  return "Changes"
        case .preview:  return "Preview"
        }
    }
}

/// The workspace / session window (analogue of `WorkspacesLayout`): a 2-pane
/// IDE-like layout — sessions + files | a switchable main pane
/// (Agent / Logs / Changes / Preview).
struct WorkspaceWindowView: View {
    let workspaceId: String?
    @Environment(AppState.self) private var app
    @State private var vm: WorkspaceViewModel?
    @State private var pane: WorkspacePane = .agent

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

            // Main: switchable pane (Agent / Logs / Changes / Preview)
            VStack(spacing: 0) {
                Picker("View", selection: $pane) {
                    ForEach(WorkspacePane.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                Divider()
                switch pane {
                case .agent:    agentPane(vm)
                case .terminal: terminalPane(vm)
                case .logs:     TerminalLogView(text: vm.rawLog)
                case .changes:  DiffView(diffs: vm.diffs, showRepo: vm.diffsSpanRepos)
                case .preview:  PreviewBrowser()
                }
            }
            .frame(minWidth: 420)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await vm.loadSession() } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
    }

    /// The Agent view: conversation + pending approvals + composer.
    @ViewBuilder
    private func agentPane(_ vm: WorkspaceViewModel) -> some View {
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
            ChatInputView(
                onSend: { prompt in Task { await vm.sendFollowUp(prompt) } },
                dictationContext: {
                    DictationContext.chat(
                        title: vm.workspace?.displayName,
                        project: vm.workspace?.branch,
                        entries: vm.entries
                    )
                }
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The Terminal view: an embedded terminal attached to the headed agent's
    /// tmux session, with an "Open in iTerm2" escape hatch.
    @ViewBuilder
    private func terminalPane(_ vm: WorkspaceViewModel) -> some View {
        if let exec = vm.activeExecution {
            TerminalPane(execId: exec.id, client: app.client)
        } else {
            TopPlaceholder(
                "No running execution",
                systemImage: "terminal",
                description: "Start a headed (interactive) agent to get a live terminal here."
            )
        }
    }
}
