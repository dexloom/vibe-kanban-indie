import SwiftUI

@main
struct VibeKanbanMacApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        // Main board window.
        WindowGroup {
            RootView()
                .environment(appState)
                .frame(minWidth: 900, minHeight: 560)
                .task { await appState.bootstrap() }
        }
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh") { Task { await appState.reloadProjects() } }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Command Palette…") { appState.showCommandPalette = true }
                    .keyboardShortcut("k", modifiers: .command)
            }
        }

        // Workspace / session window, opened per workspace id.
        WindowGroup("Workspace", id: "workspace", for: String.self) { $workspaceId in
            WorkspaceWindowView(workspaceId: workspaceId)
                .environment(appState)
                .frame(minWidth: 800, minHeight: 520)
        }

        // Preferences (⌘,)
        Settings {
            SettingsView()
                .environment(appState)
        }
    }
}
