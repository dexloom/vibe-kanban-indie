import SwiftUI

/// Settings → Projects: create / rename / recolor / delete projects, and manage
/// which repositories are linked to the selected project. Projects are the
/// board containers shown in the sidebar; mutating them here refreshes the app.
struct ProjectsSettingsView: View {
    @Environment(AppState.self) private var app
    @State private var model = ProjectsSettingsModel()
    @State private var selection: String?
    @State private var editing: ProjectEdit?

    private var selectedProject: Project? {
        app.projects.first { $0.id == selection }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if app.projects.isEmpty {
                TopPlaceholder("No projects", systemImage: "rectangle.stack",
                               description: "Create a project to start a board.")
            } else {
                projectList
                Divider()
                repoLinks
            }
            if let error = model.error {
                Divider()
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .task {
            model.client = app.client
            await model.loadRepos()
            if selection == nil { selection = app.projects.first?.id }
        }
        .onChange(of: selection) { _, id in
            Task { await model.loadLinked(projectId: id) }
        }
        .sheet(item: $editing) { edit in
            ProjectEditSheet(edit: edit) { name, color in
                Task {
                    await save(edit: edit, name: name, color: color)
                }
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Projects").font(.headline)
            if model.busy { ProgressView().controlSize(.small) }
            Spacer()
            Button {
                editing = ProjectEdit(projectId: nil, name: "", color: ProjectPalette.colors[0])
            } label: { Label("New project", systemImage: "plus") }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var projectList: some View {
        List(selection: $selection) {
            ForEach(app.projects) { project in
                HStack(spacing: 8) {
                    ColorDot(hex: project.color, size: 11)
                    Text(project.name)
                    Spacer()
                }
                .tag(project.id)
                .contextMenu {
                    Button("Edit…") {
                        editing = ProjectEdit(projectId: project.id, name: project.name, color: project.color)
                    }
                    Button("Delete…", role: .destructive) {
                        Task { await deleteProject(project) }
                    }
                }
            }
        }
        .frame(minHeight: 120)
    }

    @ViewBuilder
    private var repoLinks: some View {
        VStack(spacing: 0) {
            HStack {
                Text(selectedProject.map { "Repositories in \($0.name)" } ?? "Repositories")
                    .font(.subheadline.weight(.medium))
                Spacer()
                Menu {
                    let linkedIds = Set(model.linkedRepos.map(\.id))
                    let available = model.allRepos.filter { !linkedIds.contains($0.id) }
                    if available.isEmpty {
                        Text("No more repositories — register one in the Repositories tab.")
                    }
                    ForEach(available) { repo in
                        Button(repo.displayName) {
                            Task { await link(repo) }
                        }
                    }
                } label: { Label("Link repo", systemImage: "link") }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(selectedProject == nil)
            }
            .padding(.horizontal, 14).padding(.vertical, 8)

            if model.linkedRepos.isEmpty {
                Text("No repositories linked.")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.bottom, 10)
            } else {
                List {
                    ForEach(model.linkedRepos) { repo in
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(repo.displayName)
                                Text(repo.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Button("Unlink") { Task { await unlink(repo) } }
                                .buttonStyle(.borderless).foregroundStyle(.red)
                        }
                    }
                }
                .frame(minHeight: 80)
            }
        }
    }

    // MARK: - Actions

    private func save(edit: ProjectEdit, name: String, color: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let id = edit.projectId {
            await model.updateProject(id: id, name: trimmed, color: color)
        } else {
            let orgId = app.projects.first?.organizationId ?? LocalIds.organizationId
            let newId = await model.createProject(organizationId: orgId, name: trimmed, color: color)
            selection = newId ?? selection
        }
        await app.reloadProjects()
    }

    private func deleteProject(_ project: Project) async {
        await model.deleteProject(id: project.id)
        if selection == project.id { selection = nil }
        await app.reloadProjects()
        selection = selection ?? app.projects.first?.id
    }

    private func link(_ repo: Repo) async {
        guard let pid = selection else { return }
        await model.link(projectId: pid, repoId: repo.id)
    }

    private func unlink(_ repo: Repo) async {
        guard let pid = selection else { return }
        await model.unlink(projectId: pid, repoId: repo.id)
    }
}

/// One project being created (`projectId == nil`) or edited.
struct ProjectEdit: Identifiable {
    let projectId: String?
    var name: String
    var color: String
    var id: String { projectId ?? "new" }
}

private struct ProjectEditSheet: View {
    let edit: ProjectEdit
    var onSave: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var color: String

    init(edit: ProjectEdit, onSave: @escaping (String, String) -> Void) {
        self.edit = edit
        self.onSave = onSave
        _name = State(initialValue: edit.name)
        _color = State(initialValue: edit.color)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(edit.projectId == nil ? "New project" : "Edit project").font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("Name").font(.subheadline.weight(.medium))
                TextField("Project name", text: $name).textFieldStyle(.roundedBorder)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Color").font(.subheadline.weight(.medium))
                HStack(spacing: 8) {
                    ForEach(ProjectPalette.colors, id: \.self) { value in
                        Button {
                            color = value
                        } label: {
                            Circle().fill(Color(css: value)).frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(.primary,
                                                               lineWidth: color == value ? 2 : 0))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button(edit.projectId == nil ? "Create" : "Save") {
                    onSave(name, color); dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(18)
        .frame(width: 340)
    }
}

enum ProjectPalette {
    /// Canonical preset palette, mirrored from the web's
    /// `packages/web-core/src/shared/lib/colors.ts` (`PRESET_COLORS`). Stored as
    /// **HSL triples** — the format the backend validates and the web renders.
    static let colors = [
        "0 84% 60%", "24 95% 53%", "45 93% 58%", "158 64% 52%",
        "200 98% 39%", "271 81% 56%", "330 81% 60%", "183 74% 44%",
        "262 52% 47%", "142 71% 45%", "17 88% 40%", "231 48% 48%",
    ]
}

/// Backs the Projects settings tab: repo catalog for linking, the selected
/// project's linked repos, and project/link mutations.
@MainActor
@Observable
final class ProjectsSettingsModel {
    var client: APIClient?
    var allRepos: [Repo] = []
    var linkedRepos: [Repo] = []
    var busy = false
    var error: String?

    /// The raw defaults (repo id + target branch), kept so link/unlink preserve
    /// each repo's branch when re-saving the scratch list.
    private var linkedDefaults: [DraftWorkspaceRepo] = []

    func loadRepos() async {
        guard let client else { return }
        do { allRepos = try await client.listAllRepos().sorted { $0.displayName < $1.displayName } }
        catch { self.error = error.localizedDescription }
    }

    func loadLinked(projectId: String?) async {
        guard let client, let projectId else { linkedRepos = []; linkedDefaults = []; return }
        do {
            linkedDefaults = try await client.projectRepoDefaults(projectId: projectId)
            // Map ids to full repos for display; keep order from the defaults list.
            linkedRepos = linkedDefaults.compactMap { d in allRepos.first { $0.id == d.repoId } }
        } catch { self.error = error.localizedDescription }
    }

    @discardableResult
    func createProject(organizationId: String, name: String, color: String) async -> String? {
        await run {
            try await $0.createProject(
                CreateProjectRequest(id: nil, organizationId: organizationId, name: name, color: color)).id
        }
    }

    func updateProject(id: String, name: String, color: String) async {
        _ = await run { try await $0.updateProject(id: id, UpdateProjectRequest(name: name, color: color)) }
    }

    func deleteProject(id: String) async {
        await runVoid { try await $0.deleteProject(id: id) }
    }

    func link(projectId: String, repoId: String) async {
        guard !linkedDefaults.contains(where: { $0.repoId == repoId }) else { return }
        let raw = allRepos.first { $0.id == repoId }?.defaultTargetBranch
        let branch = (raw?.isEmpty == false) ? raw! : "main"
        let next = linkedDefaults + [DraftWorkspaceRepo(repoId: repoId, targetBranch: branch)]
        await runVoid { try await $0.setProjectRepoDefaults(projectId: projectId, repos: next) }
        await loadLinked(projectId: projectId)
    }

    func unlink(projectId: String, repoId: String) async {
        let next = linkedDefaults.filter { $0.repoId != repoId }
        await runVoid { try await $0.setProjectRepoDefaults(projectId: projectId, repos: next) }
        await loadLinked(projectId: projectId)
    }

    // MARK: - Helpers

    private func run<T>(_ work: (APIClient) async throws -> T) async -> T? {
        guard let client else { return nil }
        busy = true; defer { busy = false }
        do { error = nil; return try await work(client) }
        catch { self.error = error.localizedDescription; return nil }
    }

    private func runVoid(_ work: (APIClient) async throws -> Void) async {
        guard let client else { return }
        busy = true; defer { busy = false }
        do { error = nil; try await work(client) }
        catch { self.error = error.localizedDescription }
    }
}
