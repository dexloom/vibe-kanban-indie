import SwiftUI

/// ⌘K command palette (analogue of the web `CommandBar`): jump to a project or
/// run a quick action.
struct CommandPaletteView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var filteredProjects: [Project] {
        guard !query.isEmpty else { return app.projects }
        return app.projects.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Jump to project or action…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
            }
            .padding(12)
            Divider()
            List {
                Section("Actions") {
                    Button {
                        Task { await app.reloadProjects() }; dismiss()
                    } label: { Label("Refresh projects", systemImage: "arrow.clockwise") }
                }
                Section("Projects") {
                    ForEach(filteredProjects) { project in
                        Button {
                            app.selection = .project(project.id)
                            dismiss()
                        } label: {
                            Label { Text(project.name) } icon: { ColorDot(hex: project.color) }
                        }
                    }
                }
            }
            .listStyle(.inset)
        }
        .frame(width: 460, height: 360)
    }
}
