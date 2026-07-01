import SwiftUI

/// Browse all execution workspaces (`/workspaces`) and open them in a window —
/// styled as the Flight Deck "Workspaces" surface: a live-agent strip over a
/// process-oriented table.
struct WorkspacesListView: View {
    @Environment(AppState.self) private var app
    @Environment(\.openWindow) private var openWindow

    @State private var workspaces: [Workspace] = []
    @State private var isLoading = false
    @State private var loadedOnce = false
    @State private var error: String?
    @State private var filter: WSFilter = .active
    /// Project color resolved per workspace (via summaries) — `localWorkspaceId`
    /// and `issueId` → project color, so each row can carry its project's hue.
    @State private var colorByWorkspace: [String: String] = [:]
    @State private var colorByIssue: [String: String] = [:]

    enum WSFilter: String, CaseIterable, Identifiable { case all, active, archived; var id: String { rawValue } }

    private var nonEphemeral: [Workspace] { workspaces.filter { !$0.ephemeral } }
    private var running: [Workspace] { nonEphemeral.filter { $0.isRunning == true } }

    private var visible: [Workspace] {
        nonEphemeral
            .filter {
                switch filter {
                case .all:      return true
                case .active:   return !$0.archived
                case .archived: return $0.archived
                }
            }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.fd(12)).foregroundStyle(FlightDeck.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 26).padding(.vertical, 6)
            }
            if !running.isEmpty { liveStrip }
            tableHeader
            if visible.isEmpty {
                TopPlaceholder(
                    loadedOnce ? "No workspaces" : "Loading workspaces…",
                    systemImage: "cpu",
                    description: "Start an agent from an issue to create a workspace."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(visible) { ws in row(ws) }
                    }
                    .padding(.horizontal, 18).padding(.vertical, 6)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FlightDeck.bg)
        .navigationTitle("Workspaces")
        .task { await loadIfNeeded() }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Workspaces").font(.fd(27, .bold)).foregroundStyle(FlightDeck.text)
                Text(subtitle).font(.fd(13)).foregroundStyle(FlightDeck.textFaint)
            }
            if isLoading { ProgressView().controlSize(.small) }
            Spacer()
            Picker("", selection: $filter) {
                Text("All").tag(WSFilter.all)
                Text("Active").tag(WSFilter.active)
                Text("Archived").tag(WSFilter.archived)
            }
            .labelsHidden().pickerStyle(.segmented).fixedSize()
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).foregroundStyle(FlightDeck.textDim)
                .help("Refresh")
        }
        .padding(.horizontal, 26).padding(.top, 22).padding(.bottom, 14)
    }

    private var subtitle: String {
        let active = nonEphemeral.filter { !$0.archived }.count
        let archived = nonEphemeral.filter { $0.archived }.count
        return "\(active) active · \(archived) archived"
    }

    // MARK: Live strip

    private var liveStrip: some View {
        VStack(spacing: 8) {
            ForEach(running.prefix(2)) { ws in
                HStack(spacing: 16) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 11).fill(FlightDeck.running.opacity(0.14))
                        Circle().fill(FlightDeck.running).frame(width: 11, height: 11).fdPulse(true)
                    }
                    .frame(width: 42, height: 42)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(ws.displayName).font(.fd(15, .semibold)).foregroundStyle(FlightDeck.text)
                        FDBranchChip(text: ws.branch)
                    }
                    Spacer()
                    FDStateBadge(state: .running)
                    Button("Open") { openWindow(id: "workspace", value: ws.id) }
                        .buttonStyle(.fdPrimary)
                }
                .padding(16)
                .background(
                    RoundedRectangle(cornerRadius: FlightDeck.Radius.card)
                        .fill(LinearGradient(
                            colors: [FlightDeck.accent.opacity(0.16), FlightDeck.accent.opacity(0.02)],
                            startPoint: .leading, endPoint: .trailing))
                )
                .overlay(RoundedRectangle(cornerRadius: FlightDeck.Radius.card).strokeBorder(FlightDeck.accent.opacity(0.28)))
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(FlightDeck.accent).frame(width: 3).padding(.vertical, 1)
                }
            }
        }
        .padding(.horizontal, 26).padding(.bottom, 10)
    }

    // MARK: Table

    private var tableHeader: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: 34)
            col("Name").frame(maxWidth: .infinity, alignment: .leading)
            col("Branch").frame(width: 280, alignment: .leading)
            col("State").frame(width: 120, alignment: .leading)
            col("Updated").frame(width: 96, alignment: .leading)
            Color.clear.frame(width: 28)
        }
        .padding(.horizontal, 26).frame(height: 38)
        .overlay(alignment: .bottom) { Rectangle().fill(FlightDeck.hairline).frame(height: 1) }
    }

    private func col(_ s: String) -> some View {
        Text(s.uppercased()).font(.fd(11, .semibold)).tracking(0.8).foregroundStyle(FlightDeck.textFainter)
    }

    private func row(_ ws: Workspace) -> some View {
        let state = fdState(ws)
        return Button { openWindow(id: "workspace", value: ws.id) } label: {
            HStack(spacing: 0) {
                HStack { FDStatusDot(state: state) }.frame(width: 34)
                HStack(spacing: 8) {
                    if let pc = projectColor(for: ws) {
                        Circle().fill(Color(css: pc)).frame(width: 8, height: 8)
                            .overlay(Circle().strokeBorder(.white.opacity(0.15), lineWidth: 0.5))
                    }
                    Text(ws.displayName)
                        .font(.fd(14, ws.pinned ? .bold : .semibold)).foregroundStyle(FlightDeck.textSoft)
                        .lineLimit(1).truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 16)
                HStack { FDBranchChip(text: ws.branch) }.frame(width: 280, alignment: .leading)
                HStack { FDStateBadge(state: state) }.frame(width: 120, alignment: .leading)
                Text(ws.updatedAt, format: .dateTime.day().month())
                    .font(.fd(13)).foregroundStyle(FlightDeck.textFaint)
                    .frame(width: 96, alignment: .leading)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(FlightDeck.textGhost).frame(width: 28, alignment: .trailing)
            }
            .padding(.horizontal, 8).frame(height: 50)
            .background {
                if state == .running {
                    RoundedRectangle(cornerRadius: 9).fill(FlightDeck.accent.opacity(0.07))
                        .overlay(alignment: .leading) { Rectangle().fill(FlightDeck.accent).frame(width: 2) }
                        .clipShape(RoundedRectangle(cornerRadius: 9))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func fdState(_ ws: Workspace) -> FDState {
        if ws.isErrored == true { return .error }
        if ws.isRunning == true { return .running }
        if ws.archived { return .archived }
        return .idle
    }

    // MARK: Load

    private func loadIfNeeded() async {
        guard !loadedOnce else { return }
        await load()
    }

    private func load() async {
        guard let client = app.client else { return }
        isLoading = true
        defer { isLoading = false; loadedOnce = true }
        do {
            workspaces = try await client.listWorkspaces()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        await loadProjectColors()
    }

    /// Build workspace→project-color maps from each project's workspace summaries.
    private func loadProjectColors() async {
        guard let client = app.client else { return }
        var byWorkspace: [String: String] = [:]
        var byIssue: [String: String] = [:]
        for project in app.projects {
            let summaries = (try? await client.listWorkspaceSummaries(projectId: project.id)) ?? []
            for summary in summaries {
                if let local = summary.localWorkspaceId { byWorkspace[local] = project.color }
                if let issue = summary.issueId { byIssue[issue] = project.color }
            }
        }
        colorByWorkspace = byWorkspace
        colorByIssue = byIssue
    }

    /// The project color for a workspace (by id, else by its issue), if known.
    private func projectColor(for ws: Workspace) -> String? {
        if let c = colorByWorkspace[ws.id] { return c }
        if let task = ws.taskId, let c = colorByIssue[task] { return c }
        return nil
    }
}
