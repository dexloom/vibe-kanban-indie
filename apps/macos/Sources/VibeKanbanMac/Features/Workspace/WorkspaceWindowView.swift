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
            // Left: Agent session panel
            sessionPanel(vm)
                .frame(minWidth: 220, idealWidth: 264, maxWidth: 320, maxHeight: .infinity, alignment: .top)
                .background(LinearGradient(colors: [FlightDeck.bgDeepest, FlightDeck.bgSidebar],
                                           startPoint: .top, endPoint: .bottom))

            // Main: switchable pane (Agent / Terminal / Logs / Changes / Preview)
            VStack(spacing: 0) {
                HStack {
                    Picker("View", selection: $pane) {
                        ForEach(WorkspacePane.allCases) { Text($0.title).tag($0) }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .fixedSize()
                    Spacer()
                }
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(FlightDeck.bgDeepest)
                .overlay(alignment: .bottom) { Rectangle().fill(FlightDeck.hairline).frame(height: 1) }
                switch pane {
                case .agent:    agentPane(vm)
                case .terminal: terminalPane(vm)
                case .logs:     TerminalLogView(text: vm.rawLog)
                case .changes:  DiffView(diffs: vm.diffs, showRepo: vm.diffsSpanRepos)
                case .preview:  PreviewBrowser()
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            .background(FlightDeck.bg)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await vm.loadSession() } } label: { Image(systemName: "arrow.clockwise") }
            }
        }
    }

    // MARK: - Session panel (left)

    /// The Flight Deck "Agent session" left panel: session selector, run status,
    /// an info panel (branch / agent / started / duration), files, and a
    /// connection footer.
    @ViewBuilder
    private func sessionPanel(_ vm: WorkspaceViewModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                panelLabel("Session")
                sessionSelector(vm)
            }
            if let exec = vm.activeExecution {
                execBadge(exec.status)
                infoPanel(vm, exec)
            }
            FileTreeView(workspace: vm.workspace)
            Spacer(minLength: 0)
            Divider().overlay(FlightDeck.hairline)
            connectionFooter(vm)
        }
        .padding(16)
    }

    private func panelLabel(_ text: String) -> some View {
        Text(text.uppercased()).font(.fd(11, .semibold)).tracking(1.2)
            .foregroundStyle(FlightDeck.textFainter)
    }

    @ViewBuilder
    private func sessionSelector(_ vm: WorkspaceViewModel) -> some View {
        if vm.sessions.isEmpty {
            Text("No sessions").font(.fd(13)).foregroundStyle(FlightDeck.textFaint)
        } else {
            Menu {
                ForEach(vm.sessions) { session in
                    Button(session.displayName) { vm.selectedSessionId = session.id }
                }
            } label: {
                HStack {
                    Text(selectedSession(vm)?.displayName ?? "—")
                        .font(.fdMono(13, .semibold)).foregroundStyle(FlightDeck.textSoft)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(FlightDeck.textFaint)
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 9).fill(FlightDeck.card))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(FlightDeck.hairlineHi))
                .contentShape(Rectangle())
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        }
    }

    private func execBadge(_ status: ExecutionProcessStatus) -> some View {
        let spec: (label: String, color: Color, icon: String?, pulse: Bool) = {
            switch status {
            case .running:   return ("Running", FlightDeck.running, nil, true)
            case .completed: return ("Completed", FlightDeck.runningText, "checkmark", false)
            case .failed:    return ("Failed", FlightDeck.failedText, "xmark", false)
            case .killed:    return ("Stopped", FlightDeck.idle, "stop.fill", false)
            }
        }()
        return HStack(spacing: 7) {
            if let icon = spec.icon {
                Image(systemName: icon).font(.system(size: 11, weight: .bold))
            } else {
                Circle().fill(spec.color).frame(width: 6, height: 6).fdPulse(spec.pulse)
            }
            Text(spec.label).font(.fd(12, .semibold))
        }
        .foregroundStyle(spec.color)
        .padding(.horizontal, 11).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7).fill(spec.color.opacity(0.14)))
    }

    @ViewBuilder
    private func infoPanel(_ vm: WorkspaceViewModel, _ exec: ExecutionProcess) -> some View {
        VStack(spacing: 11) {
            if let branch = vm.workspace?.branch { infoRow("Branch", branch) }
            if let agent = agentLabel(vm) { infoRow("Agent", agent) }
            infoRow("Started", exec.startedAt.formatted(date: .omitted, time: .standard))
            infoRow("Duration", durationLabel(exec))
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: FlightDeck.Radius.panel).fill(FlightDeck.panel))
        .overlay(RoundedRectangle(cornerRadius: FlightDeck.Radius.panel).strokeBorder(FlightDeck.hairlineSoft))
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.fd(12.5, .medium)).foregroundStyle(FlightDeck.textFaint)
            Spacer(minLength: 8)
            Text(value).font(.fdMono(12.5)).foregroundStyle(FlightDeck.textSoft)
                .lineLimit(1).truncationMode(.middle)
        }
    }

    private func connectionFooter(_ vm: WorkspaceViewModel) -> some View {
        HStack(spacing: 9) {
            Circle().fill(vm.streamConnected ? FlightDeck.running : FlightDeck.idle)
                .frame(width: 8, height: 8)
                .shadow(color: vm.streamConnected ? FlightDeck.running : .clear, radius: 4)
            Text(vm.streamConnected ? "Connected" : "Connecting…")
                .font(.fd(12.5, .medium)).foregroundStyle(FlightDeck.textFaint)
            Spacer()
        }
        .padding(.top, 6)
    }

    private func selectedSession(_ vm: WorkspaceViewModel) -> Session? {
        if let id = vm.selectedSessionId, let s = vm.sessions.first(where: { $0.id == id }) { return s }
        return vm.sessions.first
    }

    private func agentLabel(_ vm: WorkspaceViewModel) -> String? {
        guard let raw = selectedSession(vm)?.executor, !raw.isEmpty else { return nil }
        return raw.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func durationLabel(_ exec: ExecutionProcess) -> String {
        let end = exec.completedAt ?? Date()
        let secs = max(0, Int(end.timeIntervalSince(exec.startedAt)))
        let m = secs / 60, s = secs % 60
        if m >= 60 { return "\(m / 60)h \(m % 60)m" }
        return m > 0 ? "\(m)m \(s)s" : "\(s)s"
    }

    /// The Agent view: conversation + pending approvals + composer.
    @ViewBuilder
    private func agentPane(_ vm: WorkspaceViewModel) -> some View {
        VStack(spacing: 0) {
            ConversationListView(entries: vm.entries, streamConnected: vm.streamConnected)
            if !vm.pendingApprovals.isEmpty {
                Divider().overlay(FlightDeck.hairline)
                VStack(spacing: 8) {
                    ForEach(vm.pendingApprovals) { approval in
                        ApprovalCardView(approval: approval) { outcome in
                            Task { await vm.respond(to: approval, outcome: outcome) }
                        }
                    }
                }
                .padding(10)
                .background(FlightDeck.bgTimeline)
            }
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
