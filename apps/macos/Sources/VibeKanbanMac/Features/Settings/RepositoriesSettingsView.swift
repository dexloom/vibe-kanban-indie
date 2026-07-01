import SwiftUI
import UniformTypeIdentifiers

/// Settings → Repositories: register existing git checkouts, edit their
/// display name / default branch / lifecycle scripts, and remove them.
/// Backed by `/api/repos`.
struct RepositoriesSettingsView: View {
    @Environment(AppState.self) private var app
    @State private var model = ReposSettingsModel()
    @State private var registering = false
    @State private var editing: Repo?
    @State private var selection: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if model.repos.isEmpty {
                TopPlaceholder(model.loadedOnce ? "No repositories" : "Loading…",
                               systemImage: "folder.badge.gearshape",
                               description: "Register a local git checkout to use it in workspaces.")
            } else {
                list
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
            await model.load()
        }
        .sheet(isPresented: $registering) {
            RepoRegisterSheet { path, name in
                Task { await model.register(path: path, displayName: name) }
            }
        }
        .sheet(item: $editing) { repo in
            RepoEditSheet(repo: repo) { req in
                Task { await model.update(id: repo.id, req) }
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Repositories").font(.headline)
            if model.busy { ProgressView().controlSize(.small) }
            Spacer()
            Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }
                .help("Refresh")
            Button { registering = true } label: { Label("Register", systemImage: "plus") }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var list: some View {
        List(selection: $selection) {
            ForEach(model.repos) { repo in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(repo.displayName).fontWeight(.medium)
                        Text(repo.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if let branch = repo.defaultTargetBranch, !branch.isEmpty {
                        Text(branch).font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                .tag(repo.id)
                .contextMenu {
                    Button("Edit…") { editing = repo }
                    Button("Delete…", role: .destructive) { Task { await model.delete(id: repo.id) } }
                }
            }
        }
    }
}

// MARK: - Register sheet

private struct RepoRegisterSheet: View {
    var onRegister: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var displayName = ""
    @State private var picking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Register repository").font(.headline)
            VStack(alignment: .leading, spacing: 4) {
                Text("Path").font(.subheadline.weight(.medium))
                HStack {
                    TextField("/path/to/git/checkout", text: $path).textFieldStyle(.roundedBorder)
                    Button("Choose…") { picking = true }
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Display name (optional)").font(.subheadline.weight(.medium))
                TextField("Defaults to the folder name", text: $displayName).textFieldStyle(.roundedBorder)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Register") {
                    let name = displayName.trimmingCharacters(in: .whitespaces)
                    onRegister(path.trimmingCharacters(in: .whitespaces), name.isEmpty ? nil : name)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(path.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(18)
        .frame(width: 440)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            if case let .success(url) = result {
                path = url.path
                if displayName.isEmpty { displayName = url.lastPathComponent }
            }
        }
    }
}

// MARK: - Edit sheet

private struct RepoEditSheet: View {
    let repo: Repo
    var onSave: (UpdateRepoRequest) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var displayName: String
    @State private var defaultBranch: String
    @State private var setupScript: String
    @State private var cleanupScript: String
    @State private var devServerScript: String

    init(repo: Repo, onSave: @escaping (UpdateRepoRequest) -> Void) {
        self.repo = repo
        self.onSave = onSave
        _displayName = State(initialValue: repo.displayName)
        _defaultBranch = State(initialValue: repo.defaultTargetBranch ?? "")
        _setupScript = State(initialValue: repo.setupScript ?? "")
        _cleanupScript = State(initialValue: repo.cleanupScript ?? "")
        _devServerScript = State(initialValue: repo.devServerScript ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Edit \(repo.name)").font(.headline).padding(.bottom, 8)
            Text(repo.path).font(.caption).foregroundStyle(.secondary).padding(.bottom, 10)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("Display name") { TextField("", text: $displayName).textFieldStyle(.roundedBorder) }
                    field("Default target branch") {
                        TextField("e.g. main", text: $defaultBranch).textFieldStyle(.roundedBorder)
                    }
                    scriptField("Setup script", text: $setupScript)
                    scriptField("Cleanup script", text: $cleanupScript)
                    scriptField("Dev server script", text: $devServerScript)
                }
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                Button("Save") { onSave(buildRequest()); dismiss() }
                    .buttonStyle(.borderedProminent)
                    .disabled(displayName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.top, 10)
        }
        .padding(18)
        .frame(width: 460, height: 440)
    }

    private func buildRequest() -> UpdateRepoRequest {
        func cleaned(_ s: String) -> String? {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        return UpdateRepoRequest(
            displayName: displayName.trimmingCharacters(in: .whitespaces),
            setupScript: cleaned(setupScript),
            cleanupScript: cleaned(cleanupScript),
            devServerScript: cleaned(devServerScript),
            defaultTargetBranch: cleaned(defaultBranch),
            defaultWorkingDir: nil
        )
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.medium))
            content()
        }
    }

    private func scriptField(_ label: String, text: Binding<String>) -> some View {
        field(label) {
            TextEditor(text: text)
                .font(.system(.callout, design: .monospaced))
                .frame(height: 60)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
        }
    }
}

// MARK: - Model

/// Backs the Repositories settings tab. Holds the repo catalog and CRUD.
@MainActor
@Observable
final class ReposSettingsModel {
    var client: APIClient?
    var repos: [Repo] = []
    var busy = false
    var loadedOnce = false
    var error: String?

    func load() async {
        guard let client else { return }
        busy = true; defer { busy = false; loadedOnce = true }
        do { repos = try await client.listAllRepos().sorted { $0.displayName < $1.displayName }; error = nil }
        catch { self.error = error.localizedDescription }
    }

    func register(path: String, displayName: String?) async {
        await mutate { try await $0.registerRepo(RegisterRepoRequest(path: path, displayName: displayName)) }
    }

    func update(id: String, _ req: UpdateRepoRequest) async {
        await mutate { try await $0.updateRepo(id: id, req) }
    }

    func delete(id: String) async {
        await mutate { try await $0.deleteRepo(id: id) }
    }

    private func mutate(_ work: (APIClient) async throws -> Void) async {
        guard let client else { return }
        busy = true
        do { error = nil; try await work(client) }
        catch { self.error = error.localizedDescription }
        busy = false
        await load()
    }
}
