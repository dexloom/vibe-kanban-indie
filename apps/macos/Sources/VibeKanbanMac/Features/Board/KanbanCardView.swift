import SwiftUI

/// A single kanban card (analogue of `KanbanCardContent`).
struct KanbanCardView: View {
    let issue: Issue
    let tags: [Tag]
    let assigneeNames: [String]
    let workspaceCount: Int
    let isSelected: Bool
    /// The issue's current status (state) — rendered as a tag in the footer.
    var status: ProjectStatus? = nil
    /// Aggregated diff stats across the issue's workspaces.
    var changes: BoardViewModel.IssueChanges = .init()

    private var hasAgent: Bool { workspaceCount > 0 }
    private var hasFooter: Bool {
        status != nil || hasAgent || changes.any || !assigneeNames.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(issue.simpleId)
                    .font(.fdMono(11, .semibold)).tracking(0.4)
                    .foregroundStyle(FlightDeck.textFaint)
                Spacer()
                if let priority = issue.priority {
                    PriorityBadge(priority: priority, showLabel: false)
                }
            }

            Text(issue.title)
                .font(.fd(14, .semibold))
                .foregroundStyle(FlightDeck.textSoft)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            if let description = issue.description, !description.isEmpty {
                Text(description)
                    .font(.fd(12.5))
                    .foregroundStyle(FlightDeck.textDim)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(tags) { TagChip(tag: $0) }
                    }
                }
            }

            if hasFooter {
                HStack(spacing: 8) {
                    if let status {
                        FDStatusTag(name: status.name, color: status.color)
                    }
                    if hasAgent {
                        FDAgentChip(model: "opus", running: false)
                    }
                    Spacer(minLength: 4)
                    if changes.any {
                        FDDiffStat(add: changes.added, del: changes.removed)
                    }
                    if !assigneeNames.isEmpty {
                        AvatarStack(names: assigneeNames)
                    }
                }
            }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fdCard(selected: isSelected)
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: FlightDeck.Radius.card)
                    .strokeBorder(FlightDeck.accent.opacity(0.55), lineWidth: 1.5)
                    .shadow(color: FlightDeck.accent.opacity(0.5), radius: 13)
            }
        }
        .contentShape(Rectangle())
    }
}
