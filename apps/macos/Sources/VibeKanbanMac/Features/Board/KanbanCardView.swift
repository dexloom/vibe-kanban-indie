import SwiftUI

/// A single kanban card (analogue of `KanbanCardContent`).
struct KanbanCardView: View {
    let issue: Issue
    let tags: [Tag]
    let assigneeNames: [String]
    let workspaceCount: Int
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(issue.simpleId)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                if let priority = issue.priority {
                    PriorityBadge(priority: priority, showLabel: false)
                }
            }

            Text(issue.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(3)
                .multilineTextAlignment(.leading)

            if let description = issue.description, !description.isEmpty {
                Text(description)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            if !tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(tags) { TagChip(tag: $0) }
                    }
                }
            }

            if !assigneeNames.isEmpty || workspaceCount > 0 {
                HStack {
                    if workspaceCount > 0 {
                        Badge(text: "\(workspaceCount)", systemImage: "cpu", tint: .accentColor)
                    }
                    Spacer()
                    if !assigneeNames.isEmpty {
                        AvatarStack(names: assigneeNames)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(isSelected ? Color.accentColor : Color.black.opacity(0.08),
                              lineWidth: isSelected ? 2 : 0.5)
        )
        .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
        .contentShape(Rectangle())
    }
}
