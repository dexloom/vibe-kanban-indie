import Foundation
import Observation

enum BoardSortField: String, CaseIterable, Identifiable {
    case sortOrder = "Manual"
    case priority = "Priority"
    case createdAt = "Created"
    case updatedAt = "Updated"
    case title = "Title"
    var id: String { rawValue }
}

enum BoardViewMode: String, CaseIterable, Identifiable {
    case board = "Board"
    case list = "List"
    var id: String { rawValue }
}

/// Loads and filters the board for one project, and performs mutations.
@MainActor
@Observable
final class BoardViewModel {
    let project: Project
    private let client: APIClient

    var statuses: [ProjectStatus] = []
    var issues: [Issue] = []
    var tags: [Tag] = []
    var issueTags: [IssueTag] = []
    var assignees: [IssueAssignee] = []
    var workspaceSummaries: [WorkspaceSummary] = []

    var isLoading = false
    var hasLoaded = false
    var error: String?

    // Filters / view options
    var search = ""
    var priorityFilter: Set<IssuePriority> = []
    var sortField: BoardSortField = .sortOrder
    var showWorkspaces = true

    init(project: Project, client: APIClient) {
        self.project = project
        self.client = client
    }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        await load()
    }

    func load() async {
        isLoading = true
        hasLoaded = true
        defer { isLoading = false }
        do {
            async let statuses = client.listStatuses(projectId: project.id)
            async let issues = client.listIssues(projectId: project.id)
            async let tags = client.listTags(projectId: project.id)
            async let issueTags = client.listIssueTags(projectId: project.id)
            async let assignees = client.listIssueAssignees(projectId: project.id)
            self.statuses = try await statuses
            self.issues = try await issues
            self.tags = try await tags
            self.issueTags = try await issueTags
            self.assignees = try await assignees
            // Workspaces are best-effort (sub-cards).
            self.workspaceSummaries = (try? await client.listWorkspaceSummaries(projectId: project.id)) ?? []
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Derived

    var visibleStatuses: [ProjectStatus] {
        statuses.filter { !$0.hidden }.sorted { $0.sortOrder < $1.sortOrder }
    }

    func issues(in status: ProjectStatus) -> [Issue] {
        var result = issues.filter { $0.statusId == status.id }
        if !search.isEmpty {
            let q = search.lowercased()
            result = result.filter {
                $0.title.lowercased().contains(q)
                    || ($0.description?.lowercased().contains(q) ?? false)
                    || $0.simpleId.lowercased().contains(q)
            }
        }
        if !priorityFilter.isEmpty {
            result = result.filter { $0.priority.map { priorityFilter.contains($0) } ?? false }
        }
        return result.sorted(by: sortComparator)
    }

    private func sortComparator(_ a: Issue, _ b: Issue) -> Bool {
        switch sortField {
        case .sortOrder: return a.sortOrder < b.sortOrder
        case .priority: return priorityRank(a.priority) < priorityRank(b.priority)
        case .createdAt: return a.createdAt > b.createdAt
        case .updatedAt: return a.updatedAt > b.updatedAt
        case .title: return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
        }
    }

    private func priorityRank(_ p: IssuePriority?) -> Int {
        switch p {
        case .urgent: return 0
        case .high: return 1
        case .medium: return 2
        case .low: return 3
        case nil: return 4
        }
    }

    func tags(for issue: Issue) -> [Tag] {
        let ids = Set(issueTags.filter { $0.issueId == issue.id }.map(\.tagId))
        return tags.filter { ids.contains($0.id) }
    }

    func assigneeUserIds(for issue: Issue) -> [String] {
        assignees.filter { $0.issueId == issue.id }.map(\.userId)
    }

    func workspaceCount(for issue: Issue) -> Int {
        workspaceSummaries.filter { $0.issueId == issue.id && !$0.archived }.count
    }

    /// Aggregate diff stats across an issue's non-archived workspaces.
    struct IssueChanges: Equatable {
        var files = 0
        var added = 0
        var removed = 0
        var any: Bool { added > 0 || removed > 0 || files > 0 }
    }

    func changes(for issue: Issue) -> IssueChanges {
        let summaries = workspaceSummaries.filter { $0.issueId == issue.id && !$0.archived }
        return IssueChanges(
            files: summaries.compactMap(\.filesChanged).reduce(0, +),
            added: summaries.compactMap(\.linesAdded).reduce(0, +),
            removed: summaries.compactMap(\.linesRemoved).reduce(0, +)
        )
    }

    func issue(id: String) -> Issue? { issues.first { $0.id == id } }
    func status(id: String) -> ProjectStatus? { statuses.first { $0.id == id } }

    // MARK: - Mutations

    /// Move an issue to a status, appended to the end of that column.
    func move(issueId: String, to statusId: String) async {
        guard let idx = issues.firstIndex(where: { $0.id == issueId }) else { return }
        let targetMax = issues.filter { $0.statusId == statusId }.map(\.sortOrder).max() ?? 0
        let newSort = targetMax + 1
        // optimistic
        issues[idx].statusId = statusId
        issues[idx].sortOrder = newSort
        do {
            _ = try await client.bulkUpdateIssues([
                BulkIssueItem(id: issueId, statusId: statusId, sortOrder: newSort, priority: nil, title: nil)
            ])
        } catch {
            self.error = error.localizedDescription
            await load()
        }
    }

    func createIssue(
        title: String,
        description: String? = nil,
        statusId: String,
        priority: IssuePriority?,
        extensionMetadata: JSONValue = .object([:])
    ) async {
        let nextSort = (issues.filter { $0.statusId == statusId }.map(\.sortOrder).max() ?? 0) + 1
        var req = CreateIssueRequest(
            projectId: project.id, statusId: statusId, title: title, sortOrder: nextSort)
        req.description = description
        req.priority = priority
        req.extensionMetadata = extensionMetadata
        do {
            let created = try await client.createIssue(req)
            issues.append(created)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func update(issueId: String, _ req: UpdateIssueRequest) async {
        do {
            let updated = try await client.updateIssue(id: issueId, req)
            if let idx = issues.firstIndex(where: { $0.id == issueId }) {
                issues[idx] = updated
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
