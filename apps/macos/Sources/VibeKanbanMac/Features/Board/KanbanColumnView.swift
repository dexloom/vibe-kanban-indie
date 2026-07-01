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
                            isSelected: selectedIssueId == issue.id,
                            status: status,
                            changes: vm.changes(for: issue)
                        )
                        .onTapGesture { onSelect(issue) }
                        .draggable(issue.id)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .padding(11)
        .frame(width: 290)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            RoundedRectangle(cornerRadius: FlightDeck.Radius.panel)
                .fill(isTargeted ? FlightDeck.accent.opacity(0.12) : Color.white.opacity(0.015))
        )
        .overlay(
            RoundedRectangle(cornerRadius: FlightDeck.Radius.panel)
                .strokeBorder(isTargeted ? FlightDeck.accent : FlightDeck.hairlineSoft, lineWidth: isTargeted ? 1.5 : 1)
        )
        .dropDestination(for: String.self) { ids, _ in
            for id in ids { Task { await vm.move(issueId: id, to: status.id) } }
            return true
        } isTargeted: { isTargeted = $0 }
    }

    private var header: some View {
        HStack(spacing: 9) {
            ColorDot(hex: status.color)
            Text(status.name).font(.fd(13.5, .semibold)).foregroundStyle(FlightDeck.textMuted)
            Text("\(columnIssues.count)")
                .font(.fdMono(12, .semibold)).foregroundStyle(FlightDeck.textFainter)
            Spacer()
            Button {
                onAddCard(status)
            } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless)
                .foregroundStyle(FlightDeck.textFainter)
                .help("Add issue to \(status.name)")
        }
        .padding(.horizontal, 4).padding(.bottom, 5)
    }
}
