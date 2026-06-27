import SwiftUI

/// The main window: a sidebar of projects/workspaces + the selected surface.
struct RootView: View {
    @Environment(AppState.self) private var app
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var app = app
        NavigationSplitView(columnVisibility: $columnVisibility) {
            ProjectSidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } detail: {
            detail
        }
        .sheet(isPresented: $app.showCommandPalette) {
            CommandPaletteView()
                .environment(app)
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch app.connection {
        case .connecting, .unknown:
            ContentUnavailableView {
                Label("Connecting to vibe-kanban…", systemImage: "antenna.radiowaves.left.and.right")
            }
        case .disconnected(let message):
            ContentUnavailableView {
                Label("Backend unavailable", systemImage: "bolt.horizontal.circle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await app.bootstrap() } }
            }
        case .connected:
            switch app.selection {
            case .workspaces:
                WorkspacesListView()
            case .project:
                if let project = app.selectedProject, let vm = app.board(for: project) {
                    BoardScreen(vm: vm)
                } else {
                    ContentUnavailableView("No project selected",
                                           systemImage: "rectangle.stack",
                                           description: Text("Pick a project from the sidebar."))
                }
            case .none:
                ContentUnavailableView("Nothing selected",
                                       systemImage: "sidebar.left",
                                       description: Text("Pick a project or Workspaces."))
            }
        }
    }
}
