import SwiftUI
import WebKit

/// Right inspector with Logs / Changes / Preview tabs (analogue of the web
/// `RightSidebar`).
struct RightInspector: View {
    let rawLog: String
    let workspace: Workspace?

    var body: some View {
        TabView {
            TerminalLogView(text: rawLog)
                .tabItem { Label("Logs", systemImage: "terminal") }
            DiffView(workspace: workspace)
                .tabItem { Label("Changes", systemImage: "plus.forwardslash.minus") }
            PreviewBrowser()
                .tabItem { Label("Preview", systemImage: "safari") }
        }
        .padding(6)
    }
}

/// Raw stdout/stderr from the raw-logs WebSocket, monospaced + auto-scrolling.
struct TerminalLogView: View {
    let text: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text.isEmpty ? "No output yet." : text)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .id("logEnd")
            }
            .onChange(of: text) { proxy.scrollTo("logEnd", anchor: .bottom) }
            .background(Color(nsColor: .textBackgroundColor))
        }
    }
}

/// Diff viewer placeholder. A full version would consume `/git/diff/ws` and
/// render `FileChange.unified_diff` with red/green lines. (sketch)
struct DiffView: View {
    let workspace: Workspace?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Changes", systemImage: "plus.forwardslash.minus").font(.headline)
            if let branch = workspace?.branch {
                Text("Branch: \(branch)").font(.caption).foregroundStyle(.secondary)
            }
            Text("Diff streaming via /workspaces/{id}/git/diff/ws — not wired in this sketch.")
                .font(.caption).foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(8)
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
