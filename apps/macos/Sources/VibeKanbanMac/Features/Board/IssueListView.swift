import SwiftUI

/// Flight Deck list view of the board's issues — process rows with state + diff.
struct IssueListView: View {
    @Bindable var vm: BoardViewModel
    @Binding var selectedIssueId: String?

    private var rows: [Issue] {
        vm.visibleStatuses.flatMap { vm.issues(in: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            tableHeader
            if rows.isEmpty {
                TopPlaceholder("No issues", systemImage: "doc.text",
                               description: "Create an issue to get started.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(rows) { row($0) }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 6)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FlightDeck.bg)
    }

    private var tableHeader: some View {
        HStack(spacing: 0) {
            col("ID").frame(width: 92, alignment: .leading)
            col("Title").frame(maxWidth: .infinity, alignment: .leading)
            col("State").frame(width: 150, alignment: .leading)
            col("Priority").frame(width: 96, alignment: .leading)
            col("Changes").frame(width: 110, alignment: .leading)
            col("Updated").frame(width: 90, alignment: .leading)
        }
        .padding(.horizontal, 22).frame(height: 36)
        .overlay(alignment: .bottom) { Rectangle().fill(FlightDeck.hairline).frame(height: 1) }
    }

    private func col(_ s: String) -> some View {
        Text(s.uppercased()).font(.fd(11, .semibold)).tracking(0.8).foregroundStyle(FlightDeck.textFainter)
    }

    private func row(_ issue: Issue) -> some View {
        let status = vm.status(id: issue.statusId)
        let changes = vm.changes(for: issue)
        let selected = selectedIssueId == issue.id
        return Button { selectedIssueId = issue.id } label: {
            HStack(spacing: 0) {
                Text(issue.simpleId).font(.fdMono(12, .semibold)).foregroundStyle(FlightDeck.textFaint)
                    .frame(width: 92, alignment: .leading)
                Text(issue.title).font(.fd(13.5, .medium)).foregroundStyle(FlightDeck.textSoft)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 12)
                HStack {
                    if let status { FDStatusTag(name: status.name, color: status.color) }
                }.frame(width: 150, alignment: .leading)
                HStack {
                    if let p = issue.priority { PriorityBadge(priority: p) }
                }.frame(width: 96, alignment: .leading)
                HStack {
                    if changes.any { FDDiffStat(add: changes.added, del: changes.removed) }
                }.frame(width: 110, alignment: .leading)
                Text(issue.updatedAt, format: .dateTime.day().month())
                    .font(.fd(13)).foregroundStyle(FlightDeck.textFaint)
                    .frame(width: 90, alignment: .leading)
            }
            .padding(.horizontal, 8).frame(height: 46)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 8).fill(FlightDeck.accent.opacity(0.10))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
