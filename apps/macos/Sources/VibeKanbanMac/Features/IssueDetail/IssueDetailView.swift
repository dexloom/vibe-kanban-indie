import SwiftUI

/// Inspector panel for one issue (analogue of `KanbanIssuePanel`): editable
/// title/description, properties, and collapsible sections.
struct IssueDetailView: View {
    let issue: Issue
    @Bindable var vm: BoardViewModel

    @Environment(AppState.self) private var app
    @Environment(\.openWindow) private var openWindow

    @State private var title = ""
    @State private var descriptionText = ""

    private var linkedWorkspaces: [WorkspaceSummary] {
        vm.workspaceSummaries.filter { $0.issueId == issue.id }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                Divider()
                properties
                Divider()
                descriptionEditor
                Divider()
                sections
            }
            .padding(16)
        }
        .task(id: issue.id) {
            title = issue.title
            descriptionText = issue.description ?? ""
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(issue.simpleId)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            TextField("Title", text: $title, axis: .vertical)
                .font(.title3.weight(.semibold))
                .textFieldStyle(.plain)
                .onSubmit(saveTitle)
            Button("Save title", action: saveTitle)
                .buttonStyle(.borderless)
                .font(.caption)
                .opacity(title != issue.title ? 1 : 0)
        }
    }

    // MARK: - Properties

    private var properties: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("Status") {
                Menu {
                    ForEach(vm.statuses.sorted { $0.sortOrder < $1.sortOrder }) { status in
                        Button {
                            Task { await vm.update(issueId: issue.id, UpdateIssueRequest(statusId: status.id)) }
                        } label: {
                            Label(status.name, systemImage: status.id == issue.statusId ? "checkmark" : "")
                        }
                    }
                } label: {
                    if let status = vm.status(id: issue.statusId) {
                        HStack(spacing: 5) { ColorDot(hex: status.color); Text(status.name) }
                    } else { Text("—") }
                }
                .menuStyle(.borderlessButton).fixedSize()
            }

            LabeledContent("Priority") {
                Menu {
                    ForEach(IssuePriority.allCases, id: \.self) { p in
                        Button {
                            Task { await vm.update(issueId: issue.id, UpdateIssueRequest(priority: p)) }
                        } label: {
                            Label(p.label, systemImage: p == issue.priority ? "checkmark" : p.systemImage)
                        }
                    }
                } label: {
                    if let p = issue.priority { PriorityBadge(priority: p) } else { Text("None") }
                }
                .menuStyle(.borderlessButton).fixedSize()
            }

            let tags = vm.tags(for: issue)
            if !tags.isEmpty {
                LabeledContent("Tags") {
                    HStack { ForEach(tags) { TagChip(tag: $0) } }
                }
            }

            let assignees = vm.assigneeUserIds(for: issue)
            if !assignees.isEmpty {
                LabeledContent("Assignees") {
                    AvatarStack(names: assignees.map { String($0.prefix(6)) })
                }
            }
        }
    }

    // MARK: - Description

    private var descriptionEditor: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Description").font(.headline)
            TextEditor(text: $descriptionText)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            HStack {
                Spacer()
                Button("Save description", action: saveDescription)
                    .disabled(descriptionText == (issue.description ?? ""))
            }
            if !descriptionText.isEmpty {
                DisclosureGroup("Preview") { MarkdownText(text: descriptionText) }
                    .font(.caption)
            }
        }
    }

    // MARK: - Sections

    private var sections: some View {
        VStack(alignment: .leading, spacing: 6) {
            DisclosureGroup("Workspaces (\(linkedWorkspaces.count))") {
                if linkedWorkspaces.isEmpty {
                    Text("No workspaces linked.").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(linkedWorkspaces) { ws in
                    Button {
                        if let id = ws.localWorkspaceId { openWindow(id: "workspace", value: id) }
                    } label: {
                        HStack {
                            Image(systemName: "cpu")
                            Text(ws.name ?? "Workspace")
                            Spacer()
                            if let f = ws.filesChanged { Text("\(f) files").foregroundStyle(.secondary) }
                            Image(systemName: "arrow.up.right.square")
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(ws.localWorkspaceId == nil)
                }
            }
            sectionPlaceholder("Pipeline", systemImage: "slider.horizontal.3",
                               note: "Executor config + custom prompts. (sketch)")
            sectionPlaceholder("Intake / Spec", systemImage: "sparkles",
                               note: "Generate a spec from this brief. (sketch)")
            sectionPlaceholder("Relationships", systemImage: "link",
                               note: "Blocks / depends-on. (sketch)")
            sectionPlaceholder("Sub-issues", systemImage: "list.bullet.indent",
                               note: "Nested issues. (sketch)")
            sectionPlaceholder("Comments", systemImage: "text.bubble",
                               note: "Discussion thread. (sketch)")
        }
    }

    private func sectionPlaceholder(_ title: String, systemImage: String, note: String) -> some View {
        DisclosureGroup {
            Text(note).font(.caption).foregroundStyle(.secondary)
        } label: {
            Label(title, systemImage: systemImage)
        }
    }

    // MARK: - Actions

    private func saveTitle() {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != issue.title else { return }
        Task { await vm.update(issueId: issue.id, UpdateIssueRequest(title: trimmed)) }
    }

    private func saveDescription() {
        Task { await vm.update(issueId: issue.id, UpdateIssueRequest(description: descriptionText)) }
    }
}
