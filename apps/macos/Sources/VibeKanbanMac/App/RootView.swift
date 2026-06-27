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
            TopPlaceholder("Connecting to vibe-kanban…",
                           systemImage: "antenna.radiowaves.left.and.right")
        case .disconnected(let message):
            TopPlaceholder("Backend unavailable",
                           systemImage: "bolt.horizontal.circle",
                           description: message) {
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
                    TopPlaceholder("No project selected",
                                   systemImage: "rectangle.stack",
                                   description: "Pick a project from the sidebar.")
                }
            case .none:
                TopPlaceholder("Nothing selected",
                               systemImage: "sidebar.left",
                               description: "Pick a project or Workspaces.")
            }
        }
    }
}
