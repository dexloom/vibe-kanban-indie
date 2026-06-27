import SwiftUI

/// Native `Table` alternative to the board (analogue of the web `IssueListView`).
struct IssueListView: View {
    @Bindable var vm: BoardViewModel
    @Binding var selectedIssueId: String?

    private var rows: [Issue] {
        vm.visibleStatuses.flatMap { vm.issues(in: $0) }
    }

    var body: some View {
        Table(rows, selection: Binding(
            get: { selectedIssueId.map { Set([$0]) } ?? [] },
            set: { selectedIssueId = $0.first }
        )) {
            TableColumn("ID") { issue in
                Text(issue.simpleId).font(.system(.body, design: .monospaced))
            }.width(90)
            TableColumn("Title", value: \.title)
            TableColumn("Status") { issue in
                if let status = vm.status(id: issue.statusId) {
                    HStack(spacing: 5) { ColorDot(hex: status.color); Text(status.name) }
                }
            }.width(140)
            TableColumn("Priority") { issue in
                if let p = issue.priority { PriorityBadge(priority: p) }
            }.width(110)
            TableColumn("Updated") { issue in
                Text(issue.updatedAt, style: .date).foregroundStyle(.secondary)
            }.width(110)
        }
    }
}
