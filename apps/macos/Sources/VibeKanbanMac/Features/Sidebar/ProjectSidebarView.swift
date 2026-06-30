import SwiftUI

/// Sidebar: connection status + Workspaces entry + project list.
struct ProjectSidebarView: View {
    @Environment(AppState.self) private var app
    @State private var showNotifications = false
    @State private var showExport = false

    var body: some View {
        @Bindable var app = app
        List(selection: $app.selection) {
            Section {
                Label("Workspaces", systemImage: "cpu")
                    .tag(SidebarSelection.workspaces)
            }
            Section("Projects") {
                ForEach(app.projects) { project in
                    Label {
                        Text(project.name)
                    } icon: {
                        ColorDot(hex: project.color)
                    }
                    .tag(SidebarSelection.project(project.id))
                }
                if app.projects.isEmpty && app.connection.isConnected {
                    Text("No projects").foregroundStyle(.secondary)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { connectionFooter }
        .toolbar {
            ToolbarItemGroup {
                Button { showNotifications = true } label: { Image(systemName: "bell") }
                    .help("Notifications")
                Button { showExport = true } label: { Image(systemName: "square.and.arrow.up") }
                    .help("Export")
                Button { Task { await app.reloadProjects() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Reload projects")
            }
        }
        .sheet(isPresented: $showNotifications) { NotificationsView() }
        .sheet(isPresented: $showExport) { ExportView().environment(app) }
    }

    private var connectionFooter: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(app.connection.isConnected ? FlightDeck.running : FlightDeck.warning)
                .frame(width: 8, height: 8)
                .shadow(color: app.connection.isConnected ? FlightDeck.running : .clear, radius: 4)
            Text(app.connection.label)
                .font(.fd(12, .medium))
                .foregroundStyle(FlightDeck.textFaint)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }
}
