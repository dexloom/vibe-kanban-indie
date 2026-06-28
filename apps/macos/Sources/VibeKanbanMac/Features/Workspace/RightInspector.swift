import SwiftUI
import WebKit

// The Logs / Changes / Preview panes (analogue of the web `RightSidebar`).
// These are selected via the workspace pane switch in `WorkspaceWindowView`.

/// Raw stdout/stderr from the raw-logs WebSocket: ANSI-stripped, monospaced,
/// auto-scrolling, with copy + auto-scroll controls.
struct TerminalLogView: View {
    let text: String
    @State private var autoScroll = true

    private var clean: String { Self.stripANSI(text) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Label("Raw logs", systemImage: "terminal")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Toggle("Auto-scroll", isOn: $autoScroll)
                    .toggleStyle(.checkbox).font(.caption)
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(clean, forType: .string)
                } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.borderless)
                    .help("Copy logs")
                    .disabled(text.isEmpty)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            Divider()
            if text.isEmpty {
                TopPlaceholder(
                    "No output yet",
                    systemImage: "terminal",
                    description: "Raw stdout/stderr from the running process streams here."
                )
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(clean)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .id("logEnd")
                    }
                    .onChange(of: text) {
                        if autoScroll { proxy.scrollTo("logEnd", anchor: .bottom) }
                    }
                    .background(Color(nsColor: .textBackgroundColor))
                }
            }
        }
    }

    /// Strip ANSI CSI escape sequences (colors / cursor moves) so raw agent and
    /// script output is readable as plain text. Colors aren't rendered.
    static func stripANSI(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        guard let regex = Self.ansiRegex else { return s }
        let range = NSRange(s.startIndex..., in: s)
        return regex.stringByReplacingMatches(in: s, range: range, withTemplate: "")
    }

    private static let ansiRegex = try? NSRegularExpression(
        pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]"
    )
}

/// The **Changes** pane: the live workspace git diff streamed over
/// `/workspaces/{id}/git/diff/ws`, rendered as a per-file unified diff.
struct DiffView: View {
    let diffs: [DiffEntry]
    var showRepo: Bool = false

    var body: some View {
        if diffs.isEmpty {
            TopPlaceholder(
                "No changes",
                systemImage: "plus.forwardslash.minus",
                description: "Edits the agent makes in this workspace show up here."
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(diffs) { entry in
                        FileDiffView(entry: entry, showRepo: showRepo)
                    }
                }
                .padding(10)
            }
        }
    }
}

/// One collapsible file in the Changes pane: a header (change badge, path,
/// +/- counts) over the unified-diff body.
private struct FileDiffView: View {
    let entry: DiffEntry
    let showRepo: Bool
    @State private var expanded = true

    private var rendered: RenderedDiff { entry.diff.render() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                Divider()
                diffBody(for: rendered)
            }
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.18)))
    }

    private var header: some View {
        Button { withAnimation(.easeInOut(duration: 0.12)) { expanded.toggle() } } label: {
            HStack(spacing: 8) {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.caption2).foregroundStyle(.secondary)
                ChangeBadge(kind: entry.diff.change)
                Text(pathLabel)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                if rendered.additions > 0 {
                    Text("+\(rendered.additions)").font(.caption2.weight(.semibold)).foregroundStyle(.green)
                }
                if rendered.deletions > 0 {
                    Text("−\(rendered.deletions)").font(.caption2.weight(.semibold)).foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var pathLabel: String {
        let base: String
        if entry.diff.change == .renamed, let old = entry.diff.oldPath, let new = entry.diff.newPath {
            base = "\(old) → \(new)"
        } else {
            base = entry.diff.displayPath
        }
        return showRepo ? "\(entry.repoKey)/\(base)" : base
    }

    @ViewBuilder
    private func diffBody(for rendered: RenderedDiff) -> some View {
        if let lines = rendered.lines {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    DiffLineRow(line: line)
                }
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(rendered.note ?? "No preview available.")
                .font(.caption).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
    }
}

/// A single diff line, gutter-marked and tinted by kind.
private struct DiffLineRow: View {
    let line: DiffHunkLine

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(marker)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 10, alignment: .center)
            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(.caption2, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 8).padding(.vertical, 1)
        .background(background)
    }

    private var marker: String {
        switch line.kind {
        case .added:   return "+"
        case .removed: return "−"
        case .context: return ""
        }
    }

    private var background: Color {
        switch line.kind {
        case .added:   return Color.green.opacity(0.14)
        case .removed: return Color.red.opacity(0.14)
        case .context: return .clear
        }
    }
}

/// Compact letter badge for a file's change kind.
private struct ChangeBadge: View {
    let kind: DiffChangeKind

    var body: some View {
        Text(letter)
            .font(.caption2.weight(.bold).monospaced())
            .foregroundStyle(.white)
            .frame(width: 16, height: 16)
            .background(RoundedRectangle(cornerRadius: 3).fill(color))
    }

    private var letter: String {
        switch kind {
        case .added:            return "A"
        case .deleted:          return "D"
        case .modified:         return "M"
        case .renamed:          return "R"
        case .copied:           return "C"
        case .permissionChange: return "P"
        }
    }

    private var color: Color {
        switch kind {
        case .added:            return .green
        case .deleted:          return .red
        case .modified:         return .orange
        case .renamed, .copied: return .blue
        case .permissionChange: return .gray
        }
    }
}

/// WKWebView preview (analogue of the web `PreviewBrowser`). Enter a dev-server
/// URL (e.g. the preview proxy) to load it.
struct PreviewBrowser: View {
    @State private var urlString = "http://127.0.0.1:3000"
    @State private var loadURL: URL?

    var body: some View {
        VStack(spacing: 6) {
            HStack {
                TextField("Preview URL", text: $urlString)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { loadURL = URL(string: urlString) }
                Button("Go") { loadURL = URL(string: urlString) }
            }
            WebView(url: loadURL)
                .overlay {
                    if loadURL == nil {
                        Text("Enter a URL to preview the running app.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
        }
        .padding(6)
    }
}

private struct WebView: NSViewRepresentable {
    let url: URL?

    func makeNSView(context: Context) -> WKWebView { WKWebView() }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard let url else { return }
        if webView.url != url { webView.load(URLRequest(url: url)) }
    }
}
