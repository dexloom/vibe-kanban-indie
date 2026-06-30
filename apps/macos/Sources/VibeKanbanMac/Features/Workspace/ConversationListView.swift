import SwiftUI

/// The agent conversation as a **calm timeline**: thinking is quiet italics, tool
/// calls collapse to one-line status rows, system noise folds away, and messages
/// read as flowing text. Auto-scrolls to the newest entry.
struct ConversationListView: View {
    let entries: [NormalizedEntry]
    var streamConnected: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if entries.isEmpty {
                        emptyState
                    }
                    ForEach(entries) { entry in
                        ChatEntryRow(entry: entry).id(entry.id)
                    }
                }
                .padding(22)
            }
            .background(FlightDeck.bgTimeline)
            .onChange(of: entries.count) {
                if let last = entries.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(streamConnected ? "Waiting for agent output…" : "Connecting to the agent stream…",
                  systemImage: "ellipsis.bubble")
                .font(.fd(13)).foregroundStyle(FlightDeck.textDim)
            Text("If the live stream is unavailable, the Logs tab shows raw output.")
                .font(.fd(12)).foregroundStyle(FlightDeck.textFaint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 40)
    }
}

/// One timeline event, styled by kind.
struct ChatEntryRow: View {
    let entry: NormalizedEntry

    var body: some View {
        switch entry.entryType {
        case .userMessage:
            userBubble
        case .assistantMessage:
            assistantMessage
        case .thinking:
            thinking
        case .toolUse(let name, let status):
            toolRow(name: name, status: status)
        case .systemMessage:
            systemChip
        case .errorMessage:
            Label(entry.content, systemImage: "exclamationmark.octagon")
                .font(.fd(13)).foregroundStyle(FlightDeck.failedText)
        case .userFeedback(let denied):
            Label("Denied \(denied): \(entry.content)", systemImage: "hand.raised")
                .font(.fd(12)).foregroundStyle(FlightDeck.warning)
        case .other(let t) where t == "stdout" || t == "stderr":
            Text(entry.content)
                .font(.fdMono(11.5))
                .foregroundStyle(FlightDeck.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
        default:
            if !entry.content.isEmpty {
                Text(entry.content).font(.fd(13)).foregroundStyle(FlightDeck.textDim)
            }
        }
    }

    // User → right-aligned indigo bubble.
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 48)
            MarkdownText(text: entry.content)
                .padding(.horizontal, 13).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 12).fill(FlightDeck.accent.opacity(0.16)))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(FlightDeck.accent.opacity(0.26)))
        }
    }

    // Assistant → left-aligned flowing text in a quiet card.
    private var assistantMessage: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(LinearGradient(colors: [FlightDeck.accent, FlightDeck.accentSoft],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "diamond.fill").font(.system(size: 7, weight: .bold)).foregroundStyle(.white)
            }
            .frame(width: 20, height: 20)
            MarkdownText(text: entry.content)
                .frame(maxWidth: 760, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    // Thinking → sparkle + quiet italics.
    private var thinking: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "sparkle")
                .font(.system(size: 15)).foregroundStyle(FlightDeck.accent.opacity(0.85))
                .padding(.top, 1)
            Text(entry.content.isEmpty ? "Thinking…" : entry.content)
                .font(.fd(14).italic()).foregroundStyle(FlightDeck.textDim)
                .frame(maxWidth: 760, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    // System → a single folded chip.
    private var systemChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
            Text(entry.content.isEmpty ? "system message" : entry.content)
                .lineLimit(1)
        }
        .font(.fd(12)).foregroundStyle(FlightDeck.textFaint)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(FlightDeck.hairlineSoft))
    }

    // Tool → one-line status row.
    private func toolRow(name: String, status: ToolStatusKind) -> some View {
        let isMCP = name.contains("__") || name.hasPrefix("mcp")
        return HStack(spacing: 11) {
            ZStack {
                RoundedRectangle(cornerRadius: 6).fill(statusColor(status).opacity(0.16))
                Image(systemName: statusIcon(status))
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(statusColor(status))
            }
            .frame(width: 19, height: 19)
            Text(displayName(name)).font(.fdMono(12.5, .semibold)).foregroundStyle(FlightDeck.textSoft)
            if isMCP {
                Text("MCP").font(.fdMono(10, .semibold)).foregroundStyle(FlightDeck.reviewText)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 5).fill(FlightDeck.review.opacity(0.14)))
            }
            if !entry.content.isEmpty {
                Text(entry.content).font(.fdMono(12)).foregroundStyle(FlightDeck.textFaint)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                .foregroundStyle(FlightDeck.textGhost)
        }
        .padding(.horizontal, 13).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(FlightDeck.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(FlightDeck.hairlineSoft))
    }

    /// Strip an MCP server prefix (`server__tool`) down to the tool name.
    private func displayName(_ name: String) -> String {
        if let r = name.range(of: "__", options: .backwards) { return String(name[r.upperBound...]) }
        return name
    }

    private func statusIcon(_ s: ToolStatusKind) -> String {
        switch s {
        case .success: return "checkmark"
        case .failed: return "xmark"
        case .denied: return "hand.raised.fill"
        case .pendingApproval: return "questionmark"
        case .timedOut: return "clock"
        default: return "wrench.adjustable"
        }
    }

    private func statusColor(_ s: ToolStatusKind) -> Color {
        switch s {
        case .success: return FlightDeck.running
        case .failed, .timedOut: return FlightDeck.failed
        case .denied: return FlightDeck.warning
        case .pendingApproval: return FlightDeck.warning
        default: return FlightDeck.textDim
        }
    }
}
