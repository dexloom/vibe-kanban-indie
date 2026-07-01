import SwiftUI

/// Search / sort / view-mode bar above the board (analogue of the web
/// `KanbanFilterBar` + `ViewNavTabs`).
struct KanbanFilterBar: View {
    @Bindable var vm: BoardViewModel
    @Binding var viewMode: BoardViewMode

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(FlightDeck.textFainter)
                TextField("Search issues…", text: $vm.search)
                    .textFieldStyle(.plain)
                    .font(.fd(13))
                    .frame(maxWidth: 240)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: FlightDeck.Radius.control).fill(FlightDeck.card))
            .overlay(RoundedRectangle(cornerRadius: FlightDeck.Radius.control).strokeBorder(FlightDeck.hairlineHi))

            Menu {
                ForEach(IssuePriority.allCases, id: \.self) { p in
                    Toggle(p.label, isOn: Binding(
                        get: { vm.priorityFilter.contains(p) },
                        set: { on in
                            if on { vm.priorityFilter.insert(p) } else { vm.priorityFilter.remove(p) }
                        }))
                }
            } label: {
                Label(vm.priorityFilter.isEmpty ? "Priority" : "Priority (\(vm.priorityFilter.count))",
                      systemImage: "line.3.horizontal.decrease.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            Menu {
                Picker("Sort", selection: $vm.sortField) {
                    ForEach(BoardSortField.allCases) { Text($0.rawValue).tag($0) }
                }
                Toggle("Show workspaces", isOn: $vm.showWorkspaces)
            } label: {
                Label("Sort: \(vm.sortField.rawValue)", systemImage: "arrow.up.arrow.down")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()

            Spacer()

            Picker("View", selection: $viewMode) {
                ForEach(BoardViewMode.allCases) { mode in
                    Image(systemName: mode == .board ? "rectangle.split.3x1" : "list.bullet").tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .fixedSize()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}
