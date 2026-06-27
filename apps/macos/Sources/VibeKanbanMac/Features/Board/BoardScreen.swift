import SwiftUI

/// What the right inspector is showing.
enum InspectorMode: Equatable {
    case none
    case issue(String)
    case newIssue(statusId: String)
}

/// The board surface for one project: filter bar + board/list + inspector
/// (issue detail or new-issue composer). Renders immediately from the cached
/// view model; data refreshes in the background.
struct BoardScreen: View {
    @Bindable var vm: BoardViewModel
    @Environment(AppState.self) private var app
    @State private var viewMode: BoardViewMode = .board
    @State private var inspector: InspectorMode = .none
    @State private var composer: IssueComposerModel?

    private var selectedIssueId: String? {
        if case .issue(let id) = inspector { return id }
        return nil
    }

    private func startComposing(statusId: String) {
        guard let client = app.client else { return }
        composer = IssueComposerModel(
            project: vm.project, statuses: vm.statuses, client: client, initialStatusId: statusId)
        inspector = .newIssue(statusId: statusId)
    }

    private func submitComposer() {
        guard let composer else { return }
        Task {
            await vm.createIssue(
                title: composer.title.trimmingCharacters(in: .whitespacesAndNewlines),
                description: composer.finalDescription,
                statusId: composer.statusId,
                priority: composer.priority,
                extensionMetadata: composer.extensionMetadata)
        }
        clearInspector()
    }

    private func clearInspector() {
        inspector = .none
        composer = nil
    }

    var body: some View {
        VStack(spacing: 0) {
            KanbanFilterBar(vm: vm, viewMode: $viewMode)
            Divider()
            if let error = vm.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.vertical, 4)
            }
            switch viewMode {
            case .board:
                KanbanBoardView(
                    vm: vm,
                    selectedIssueId: selectedIssueId,
                    onSelect: { inspector = .issue($0.id) },
                    onAddCard: { startComposing(statusId: $0.id) }
                )
            case .list:
                IssueListView(vm: vm, selectedIssueId: listSelection)
            }
        }
        .navigationTitle(vm.project.name)
        .task(id: vm.project.id) { await vm.loadIfNeeded() }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if vm.isLoading { ProgressView().controlSize(.small) }
                Button {
                    if let first = vm.visibleStatuses.first { startComposing(statusId: first.id) }
                } label: { Image(systemName: "plus") }
                    .help("New issue")
                    .disabled(vm.visibleStatuses.isEmpty)
                Button { Task { await vm.load() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh board")
            }
        }
        .inspector(isPresented: inspectorPresented) {
            inspectorContent
                .inspectorColumnWidth(min: 320, ideal: 380, max: 520)
        }
    }

    // MARK: - Inspector

    private var inspectorPresented: Binding<Bool> {
        Binding(get: { inspector != .none }, set: { if !$0 { clearInspector() } })
    }

    private var listSelection: Binding<String?> {
        Binding(
            get: { selectedIssueId },
            set: { inspector = $0.map(InspectorMode.issue) ?? .none }
        )
    }

    @ViewBuilder
    private var inspectorContent: some View {
        switch inspector {
        case .newIssue:
            if let composer {
                IssueComposerView(
                    model: composer,
                    onCancel: { clearInspector() },
                    onCreate: { submitComposer() }
                )
            } else {
                ContentUnavailableView("Composer unavailable", systemImage: "plus")
            }
        case .issue(let id):
            if let issue = vm.issue(id: id) {
                IssueDetailView(issue: issue, vm: vm)
            } else {
                ContentUnavailableView("Issue not found", systemImage: "doc.text")
            }
        case .none:
            ContentUnavailableView("No issue selected", systemImage: "doc.text")
        }
    }
}
