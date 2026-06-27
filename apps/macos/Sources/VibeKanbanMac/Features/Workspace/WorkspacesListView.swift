import SwiftUI

/// Browse all execution workspaces (`/workspaces`) and open them in a window.
struct WorkspacesListView: View {
    @Environment(AppState.self) private var app
    @Environment(\.openWindow) private var openWindow

    @State private var workspaces: [Workspace] = []
    @State private var isLoading = false
    @State private var loadedOnce = false
    @State private var error: String?
    @State private var showArchived = false
    @State private var selection: String?

    private var visible: [Workspace] {
        workspaces
            .filter { !$0.ephemeral }
            .filter { showArchived || !$0.archived }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.vertical, 4)
            }
            if visible.isEmpty {
                TopPlaceholder(
                    loadedOnce ? "No workspaces" : "Loading workspaces…",
                    systemImage: "cpu",
                    description: "Start an agent from an issue to create a workspace."
                )
            } else {
                table
            }
        }
        .navigationTitle("Workspaces")
        .task { await loadIfNeeded() }
    }

    private var header: some View {
        HStack {
            Text("Workspaces").font(.title2.weight(.semibold))
            if isLoading { ProgressView().controlSize(.small) }
            Spacer()
            Toggle("Show archived", isOn: $showArchived).toggleStyle(.switch).controlSize(.small)
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var table: some View {
        Table(visible, selection: $selection) {
            TableColumn("") { ws in StatusDot(workspace: ws) }.width(24)
            TableColumn("Name") { ws in
                Text(ws.displayName).fontWeight(ws.pinned ? .semibold : .regular)
            }
            TableColumn("Branch") { ws in
                Text(ws.branch).font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
            }
            TableColumn("State") { ws in
                Text(stateLabel(ws)).foregroundStyle(.secondary)
            }.width(90)
            TableColumn("Updated") { ws in
                Text(ws.updatedAt, style: .date).foregroundStyle(.secondary)
            }.width(110)
            TableColumn("") { ws in
                Button("Open") { openWindow(id: "workspace", value: ws.id) }
            }.width(64)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            if let id = ids.first {
                Button("Open Workspace") { openWindow(id: "workspace", value: id) }
            }
        } primaryAction: { ids in
            if let id = ids.first { openWindow(id: "workspace", value: id) }
        }
    }

    private func stateLabel(_ ws: Workspace) -> String {
        if ws.isErrored == true { return "Errored" }
        if ws.isRunning == true { return "Running" }
        if ws.archived { return "Archived" }
        return "Idle"
    }

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
    }
}

private struct StatusDot: View {
    let workspace: Workspace
    var body: some View {
        let (color, symbol): (Color, String) = {
            if workspace.isErrored == true { return (.red, "exclamationmark.circle.fill") }
            if workspace.isRunning == true { return (.green, "play.circle.fill") }
            return (.secondary, "circle")
        }()
        Image(systemName: symbol).foregroundStyle(color)
    }
}
