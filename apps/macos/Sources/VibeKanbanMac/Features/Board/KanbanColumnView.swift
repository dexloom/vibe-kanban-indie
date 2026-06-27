import SwiftUI

/// One status column: header (with add-card button), cards, drop target.
struct KanbanColumnView: View {
    let status: ProjectStatus
    @Bindable var vm: BoardViewModel
    let selectedIssueId: String?
    var onSelect: (Issue) -> Void
    var onAddCard: (ProjectStatus) -> Void

    @State private var isTargeted = false

    private var columnIssues: [Issue] { vm.issues(in: status) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(columnIssues) { issue in
                        KanbanCardView(
                            issue: issue,
                            tags: vm.tags(for: issue),
                            assigneeNames: vm.assigneeUserIds(for: issue).map { String($0.prefix(6)) },
                            workspaceCount: vm.showWorkspaces ? vm.workspaceCount(for: issue) : 0,
                            isSelected: selectedIssueId == issue.id
                        )
                        .onTapGesture { onSelect(issue) }
                        .draggable(issue.id)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .padding(8)
        .frame(width: 290)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isTargeted ? Color.accentColor.opacity(0.12) : Color(nsColor: .windowBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isTargeted ? Color.accentColor : .clear, lineWidth: 1.5)
        )
        .dropDestination(for: String.self) { ids, _ in
            for id in ids { Task { await vm.move(issueId: id, to: status.id) } }
            return true
        } isTargeted: { isTargeted = $0 }
    }

    private var header: some View {
        HStack(spacing: 6) {
            ColorDot(hex: status.color)
            Text(status.name).font(.system(size: 12, weight: .semibold))
            Text("\(columnIssues.count)")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer()
            Button {
                onAddCard(status)
            } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless)
                .help("Add issue to \(status.name)")
        }
        .padding(.horizontal, 2)
    }
}
