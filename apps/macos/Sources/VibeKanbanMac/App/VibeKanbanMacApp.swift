import SwiftUI
import AppKit

@main
struct VibeKanbanMacApp: App {
    @State private var appState = AppState()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // Main board window.
        WindowGroup {
            RootView()
                .environment(appState)
                .frame(minWidth: 900, minHeight: 560)
                .tint(FlightDeck.accent)
                .preferredColorScheme(.dark)
                .task {
                    appDelegate.appState = appState   // so the backend is stopped on quit
                    await appState.bootstrap()
                }
        }
        .commands {
            CommandGroup(after: .toolbar) {
                Button("Refresh") { Task { await appState.reloadProjects() } }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Command Palette…") { appState.showCommandPalette = true }
                    .keyboardShortcut("k", modifiers: .command)
            }
            DictationCommands()
        }

        // Workspace / session window, opened per workspace id.
        WindowGroup("Workspace", id: "workspace", for: String.self) { $workspaceId in
            WorkspaceWindowView(workspaceId: workspaceId)
                .environment(appState)
                .frame(minWidth: 800, minHeight: 520)
                .tint(FlightDeck.accent)
                .preferredColorScheme(.dark)
        }

        // Preferences (⌘,)
        Settings {
            SettingsView()
                .environment(appState)
                .tint(FlightDeck.accent)
                .preferredColorScheme(.dark)
        }
    }
}

/// Stops a managed backend process when the app quits.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var appState: AppState?

    func applicationWillTerminate(_ notification: Notification) {
        appState?.shutdownBackend()
    }
}
