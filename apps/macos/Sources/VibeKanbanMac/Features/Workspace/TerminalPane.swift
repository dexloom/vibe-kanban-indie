import SwiftTerm
import SwiftUI

/// The workspace **Terminal** pane: an embedded, interactive terminal attached to
/// the headed Claude Code agent's `tmux` session (`vk-<execId>`), plus an
/// "Open in iTerm2" button that pops the same session out via the backend's
/// existing external-terminal flow.
///
/// A headed (interactive) agent runs under `tmux new-session -d -s vk-<execId>`;
/// any number of clients can `tmux attach -t vk-<execId>`. Here we attach a
/// native [`SwiftTerm`] terminal locally; tmux is already required for headed
/// mode, so this adds no new runtime dependency.
struct TerminalPane: View {
    let execId: String
    let client: APIClient?

    /// Bumped to force the embedded terminal to re-create and re-attach.
    @State private var attachToken = 0
    @State private var ended = false
    @State private var opening = false
    @State private var note: String?

    private var sessionName: String { "vk-\(execId)" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                EmbeddedTerminalView(sessionName: sessionName) { _ in ended = true }
                    .id("\(sessionName)#\(attachToken)")
                if ended { detached }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: execId) { attachToken += 1; ended = false; note = nil }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Label("Terminal", systemImage: "terminal")
                .font(.caption).foregroundStyle(.secondary)
            Text(sessionName)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
            Spacer()
            if let note {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
            Button { reconnect() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help("Reconnect to the tmux session")
            Button { openInITerm() } label: {
                if opening {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Open in iTerm2", systemImage: "macwindow.on.rectangle")
                }
            }
            .disabled(opening || client == nil)
            .help("Open this session in iTerm2 (an external window attached to the same tmux session)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// Shown over the dead terminal once the attach process exits (the session
    /// ended, was never headed, or tmux isn't running).
    private var detached: some View {
        TopPlaceholder(
            "Not attached",
            systemImage: "terminal",
            description: "No live tmux session “\(sessionName)”. Headed (interactive) agents run "
                + "in tmux; headless runs have no terminal. Reconnect once the agent is running, "
                + "or open it in iTerm2."
        ) {
            HStack {
                Button("Reconnect") { reconnect() }
                Button("Open in iTerm2") { openInITerm() }
                    .disabled(opening || client == nil)
            }
        }
        .background(.background)
    }

    private func reconnect() {
        note = nil
        ended = false
        attachToken += 1
    }

    private func openInITerm() {
        guard let client else { return }
        opening = true
        note = nil
        Task {
            do {
                try await client.openInteractiveTerminal(executionId: execId)
            } catch {
                note = "Couldn’t open iTerm2"
            }
            opening = false
        }
    }
}

/// `NSViewRepresentable` wrapper around SwiftTerm's `LocalProcessTerminalView`.
/// Spawns the user's login shell and `exec`s `tmux attach -t <session>`, so the
/// shell's profile sets PATH (Homebrew `tmux` resolves) and `exec` makes the
/// process end cleanly when tmux detaches or the session dies.
private struct EmbeddedTerminalView: NSViewRepresentable {
    let sessionName: String
    let onExit: (Int32?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onExit: onExit) }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = LocalProcessTerminalView(frame: .zero)
        view.processDelegate = context.coordinator
        if let font = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) as NSFont? {
            view.font = font
        }
        context.coordinator.attach(view, to: sessionName)
        return view
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {}

    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        private let onExit: (Int32?) -> Void
        init(onExit: @escaping (Int32?) -> Void) { self.onExit = onExit }

        func attach(_ view: LocalProcessTerminalView, to session: String) {
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            var vars = ProcessInfo.processInfo.environment
            vars["TERM"] = "xterm-256color"
            vars["COLORTERM"] = "truecolor"
            if vars["LANG"] == nil { vars["LANG"] = "en_US.UTF-8" }
            let env = vars.map { "\($0.key)=\($0.value)" }
            // Login shell (-l) so the user's PATH resolves tmux; `exec` so ending
            // the attach ends the process (drives processTerminated).
            let cmd = "exec tmux attach -t \(Self.shellQuoted(session))"
            view.startProcess(executable: shell, args: ["-l", "-c", cmd], environment: env)
        }

        /// Single-quote for the shell so a session name can't be misinterpreted.
        private static func shellQuoted(_ s: String) -> String {
            "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }

        // MARK: LocalProcessTerminalViewDelegate
        func processTerminated(source: TerminalView, exitCode: Int32?) { onExit(exitCode) }
        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    }
}
