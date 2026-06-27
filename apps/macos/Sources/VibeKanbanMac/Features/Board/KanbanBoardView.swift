import SwiftUI

/// Horizontally-scrolling columns of cards, pinned to the top of the board.
struct KanbanBoardView: View {
    @Bindable var vm: BoardViewModel
    let selectedIssueId: String?
    var onSelect: (Issue) -> Void
    var onAddCard: (ProjectStatus) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(vm.visibleStatuses) { status in
                    KanbanColumnView(
                        status: status,
                        vm: vm,
                        selectedIssueId: selectedIssueId,
                        onSelect: onSelect,
                        onAddCard: onAddCard
                    )
                }
            }
            .padding(12)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
