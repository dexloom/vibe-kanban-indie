import SwiftTerm
import SwiftUI

/// The workspace **Terminal** pane: a thin SwiftTerm client over the backend's
/// terminal protocol (`GET /api/terminal/ws`) — the same endpoint and wire
/// format (`TerminalCommand`/`TerminalMessage`, base64 input/output/resize) the
/// web frontend uses
/// (`packages/web-core/src/shared/providers/TerminalProvider.tsx`). The
/// **server** owns the PTY; this view is just a byte feed + keystroke source.
///
/// Two modes share one endpoint:
///  - **Plain workspace shell** (`executionProcessId` omitted) — always
///    available while a workspace is open.
///  - **Headed-agent attach** (`executionProcessId` set) — available only
///    while `attachTarget` (a live, running, interactive coding-agent
///    execution id) is non-nil; the backend validates and rejects otherwise
///    with an in-band error + clean close.
///
/// A small Shell/Agent picker appears only once an attach target exists (no
/// target ⇒ shell-only, no picker), defaulting to Agent the moment a live
/// target first appears (mirrors `WorkspacesMainContainer`'s Log/Terminal
/// toggle). "Open in iTerm2" remains the external-terminal escape hatch
/// (`POST /execution-processes/{id}/open-terminal`).
struct TerminalPane: View {
    let workspaceId: String
    /// The live headed (running, interactive) coding-agent execution's id, if
    /// any — gates the Agent tab and "Open in iTerm2".
    let attachTarget: String?
    let client: APIClient?

    private enum Mode: Equatable { case shell, attach(execId: String) }

    @State private var showAgent = false
    /// Bumped to force the shell/attach terminal to re-create and reconnect.
    @State private var shellToken = 0
    @State private var attachToken = 0
    @State private var shellEnded = false
    @State private var attachEnded = false
    @State private var opening = false
    @State private var note: String?

    private var mode: Mode {
        if let attachTarget, showAgent { return .attach(execId: attachTarget) }
        return .shell
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                switch mode {
                case .shell:
                    WSTerminalView(workspaceId: workspaceId, executionProcessId: nil, client: client) {
                        shellEnded = true
                    }
                    .id("shell#\(workspaceId)#\(shellToken)")
                    if shellEnded { detached(label: "workspace shell") }
                case .attach(let execId):
                    WSTerminalView(workspaceId: workspaceId, executionProcessId: execId, client: client) {
                        attachEnded = true
                    }
                    .id("attach#\(execId)#\(attachToken)")
                    if attachEnded { detached(label: "agent session") }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: attachTarget) { oldValue, newValue in
            if oldValue == nil, newValue != nil { showAgent = true }  // default to Agent once a live target appears
            if newValue == nil { showAgent = false }                  // no target ⇒ shell only, no picker
            attachEnded = false
            note = nil
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Label("Terminal", systemImage: "terminal")
                .font(.caption).foregroundStyle(.secondary)
            if attachTarget != nil {
                Picker("Mode", selection: $showAgent) {
                    Text("Shell").tag(false)
                    Text("Agent").tag(true)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .frame(width: 140)
            }
            Spacer()
            if let note {
                Text(note).font(.caption2).foregroundStyle(.secondary)
            }
            Button { reconnect() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help("Reconnect")
            Button { openInITerm() } label: {
                if opening {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Open in iTerm2", systemImage: "macwindow.on.rectangle")
                }
            }
            .disabled(opening || client == nil || attachTarget == nil)
            .help("Open the live agent session in iTerm2 (an external window attached to the same tmux session)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// Shown over a terminal once its socket reaches a **terminal**
    /// (non-reconnecting) state: a clean close (attach rejected / session
    /// ended) or backoff retries exhausted.
    private func detached(label: String) -> some View {
        TopPlaceholder(
            "Disconnected",
            systemImage: "terminal",
            description: "The \(label) connection ended. Reconnect to try again."
        ) {
            HStack {
                Button("Reconnect") { reconnect() }
                if attachTarget != nil {
                    Button("Open in iTerm2") { openInITerm() }
                        .disabled(opening || client == nil)
                }
            }
        }
        .background(.background)
    }

    private func reconnect() {
        note = nil
        switch mode {
        case .shell:
            shellEnded = false
            shellToken += 1
        case .attach:
            attachEnded = false
            attachToken += 1
        }
    }

    private func openInITerm() {
        guard let client, let execId = attachTarget else { return }
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

/// `NSViewRepresentable` wrapper around SwiftTerm's plain `TerminalView` (not
/// `LocalProcessTerminalView` — this pane is driven by server-sent bytes over
/// a `TerminalSocket`, not a local child process). The delegate forwards
/// keystrokes/resizes to the socket; the socket's output/error feed the view.
private struct WSTerminalView: NSViewRepresentable {
    let workspaceId: String
    let executionProcessId: String?
    let client: APIClient?
    /// Fired when the socket reaches a terminal (non-reconnecting) state.
    let onEnded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onEnded: onEnded) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        if let font = NSFont(name: "Menlo", size: 12) ?? NSFont.monospacedSystemFont(ofSize: 12, weight: .regular) as NSFont? {
            view.font = font
        }
        context.coordinator.attach(
            to: view, base: client?.baseURL, workspaceId: workspaceId, executionProcessId: executionProcessId)
        return view
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {}

    static func dismantleNSView(_ nsView: TerminalView, coordinator: Coordinator) {
        coordinator.detach()
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        private let onEnded: () -> Void
        private var socket: TerminalSocket?
        private weak var view: TerminalView?

        init(onEnded: @escaping () -> Void) { self.onEnded = onEnded }

        /// `makeNSView`/`dismantleNSView` and SwiftTerm's own delegate
        /// callbacks (keystrokes, resize) all happen on the main thread, so
        /// `MainActor.assumeIsolated` is safe here and lets us call into the
        /// `@MainActor` `TerminalSocket` synchronously.
        func attach(to view: TerminalView, base: URL?, workspaceId: String, executionProcessId: String?) {
            self.view = view
            guard let base else {
                view.feed(text: "\r\n\u{1B}[31mNo backend connection.\u{1B}[0m\r\n")
                onEnded()
                return
            }
            let terminal = view.getTerminal()
            let cols = terminal.cols > 0 ? terminal.cols : 80
            let rows = terminal.rows > 0 ? terminal.rows : 24
            MainActor.assumeIsolated {
                guard let socket = TerminalSocket(
                    base: base, workspaceId: workspaceId, executionProcessId: executionProcessId,
                    initialCols: cols, initialRows: rows
                ) else {
                    onEnded()
                    return
                }
                socket.onOutput = { [weak self] data in
                    self?.view?.feed(byteArray: ArraySlice(data))
                }
                socket.onErrorMessage = { [weak self] message in
                    self?.view?.feed(text: "\r\n\u{1B}[31m\(message)\u{1B}[0m\r\n")
                }
                socket.onTerminalEnd = { [weak self] in self?.onEnded() }
                self.socket = socket
                socket.connect()
            }
        }

        func detach() {
            MainActor.assumeIsolated {
                socket?.close()
                socket = nil
            }
        }

        // MARK: TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let bytes = Data(data)
            MainActor.assumeIsolated { socket?.sendInput(bytes) }
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            MainActor.assumeIsolated { socket?.resize(cols: newCols, rows: newRows) }
        }

        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}
