import SwiftUI

/// The agent conversation (analogue of `ConversationList`): renders normalized
/// entries and auto-scrolls to the newest.
struct ConversationListView: View {
    let entries: [NormalizedEntry]
    var streamConnected: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if entries.isEmpty {
                        emptyState
                    }
                    ForEach(entries) { entry in
                        ChatEntryRow(entry: entry).id(entry.id)
                    }
                }
                .padding(14)
            }
            .onChange(of: entries.count) {
                if let last = entries.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(streamConnected ? "Waiting for agent output…" : "Connecting to the agent stream…",
                  systemImage: "ellipsis.bubble")
                .foregroundStyle(.secondary)
            Text("If the live stream is unavailable, the Logs tab shows raw output.")
                .font(.caption).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 40)
    }
}

/// One chat row, styled by entry kind.
struct ChatEntryRow: View {
    let entry: NormalizedEntry

    var body: some View {
        switch entry.entryType {
        case .userMessage:
            bubble(alignment: .trailing, tint: .accentColor.opacity(0.15), icon: "person.fill")
        case .assistantMessage:
            bubble(alignment: .leading, tint: Color(nsColor: .controlBackgroundColor), icon: "sparkle")
        case .thinking:
            Text(entry.content.isEmpty ? "Thinking…" : entry.content)
                .font(.callout.italic()).foregroundStyle(.secondary)
        case .toolUse(let name, let status):
            toolRow(name: name, status: status)
        case .systemMessage:
            Text(entry.content).font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        case .errorMessage:
            Label(entry.content, systemImage: "exclamationmark.octagon")
                .font(.callout).foregroundStyle(.red)
        case .userFeedback(let denied):
            Label("Denied \(denied): \(entry.content)", systemImage: "hand.raised")
                .font(.caption).foregroundStyle(.orange)
        case .other(let t) where t == "stdout" || t == "stderr":
            Text(entry.content)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
        default:
            if !entry.content.isEmpty {
                Text(entry.content).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func bubble(alignment: HorizontalAlignment, tint: Color, icon: String) -> some View {
        HStack {
            if alignment == .trailing { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: icon).font(.caption2).foregroundStyle(.secondary)
                MarkdownText(text: entry.content)
            }
            .padding(10)
            .background(tint, in: RoundedRectangle(cornerRadius: 10))
            if alignment == .leading { Spacer(minLength: 40) }
        }
    }

    private func toolRow(name: String, status: ToolStatusKind) -> some View {
        HStack(spacing: 6) {
            Image(systemName: statusIcon(status)).foregroundStyle(statusColor(status))
            Text(name).font(.system(.caption, design: .monospaced))
            if !entry.content.isEmpty {
                Text(entry.content).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
    }

    private func statusIcon(_ s: ToolStatusKind) -> String {
        switch s {
        case .success: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        case .denied: return "hand.raised.fill"
        case .pendingApproval: return "questionmark.circle.fill"
        case .timedOut: return "clock.badge.exclamationmark"
        default: return "wrench.adjustable"
        }
    }

    private func statusColor(_ s: ToolStatusKind) -> Color {
        switch s {
        case .success: return .green
        case .failed, .timedOut: return .red
        case .denied: return .orange
        case .pendingApproval: return .yellow
        default: return .secondary
        }
    }
}
