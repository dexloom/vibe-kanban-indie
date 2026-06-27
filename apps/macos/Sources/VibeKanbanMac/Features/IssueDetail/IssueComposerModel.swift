import Foundation
import Observation

/// Holds the full card-creation state — basic fields + **agent selection**,
/// **pipeline** stages, and **spec/intake** generation — mirroring the web
/// composer. Builds the final description (with the `## Pipeline` block) and the
/// `extension_metadata` (`{ intake, pipeline }`) on submit.
@MainActor
@Observable
final class IssueComposerModel {
    let project: Project
    let statuses: [ProjectStatus]
    private let client: APIClient

    // Basic
    var title = ""
    var descriptionText = ""
    var statusId: String
    var priority: IssuePriority?

    // Agent selection (nil = let the orchestrator pick its default)
    var executor: BaseCodingAgent?
    var modelId = ""

    // Pipeline
    let steps = PipelineStep.defaults
    var enabledStepIds: Set<String> = []
    var customText = ""

    // Spec / intake
    var isGeneratingSpec = false
    var specError: String?
    private var intakeMetadata: JSONValue?

    init(project: Project, statuses: [ProjectStatus], client: APIClient, initialStatusId: String) {
        self.project = project
        self.statuses = statuses.sorted { $0.sortOrder < $1.sortOrder }
        self.client = client
        self.statusId = initialStatusId
        self.enabledStepIds = Set(steps.filter(\.defaultEnabled).map(\.id))
        // Pre-fill from the operator's default agent (Settings → Agents).
        self.executor = AgentDefaults.executor
        self.modelId = AgentDefaults.modelId
    }

    var canSubmit: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Executor config for spec generation / persistence.
    var executorConfig: ExecutorConfig {
        var config = ExecutorConfig(executor: executor ?? .claudeCode)
        let model = modelId.trimmingCharacters(in: .whitespaces)
        if !model.isEmpty { config.modelId = model }
        return config
    }

    /// Run the one-shot spec agent and fill title/description from the result.
    func generateSpec() async {
        let brief = ([title, descriptionText]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty })
            .joined(separator: "\n\n")
        guard !brief.isEmpty else {
            specError = "Add a title or description first to use as the brief."
            return
        }
        isGeneratingSpec = true
        specError = nil
        defer { isGeneratingSpec = false }

        let repos = (try? await client.listRepos(projectId: project.id)) ?? []
        let repoInputs = repos.map {
            WorkspaceRepoInput(repoId: $0.id, targetBranch: $0.defaultTargetBranch ?? "main")
        }
        let req = GenerateSpecRequest(
            projectId: project.id, brief: brief,
            executorConfig: executorConfig, repos: repoInputs)
        do {
            let resp = try await client.generateSpec(req)
            title = resp.title
            descriptionText = resp.description
            intakeMetadata = resp.intakeMetadata
        } catch {
            specError = error.localizedDescription
        }
    }

    /// The enabled step ids in catalog order (for metadata).
    private var orderedEnabledIds: [String] {
        steps.filter { enabledStepIds.contains($0.id) }.map(\.id)
    }

    /// Description with the `## Pipeline` block appended.
    var finalDescription: String {
        let block = CardPipeline.composeBlock(
            steps: steps, enabledIds: enabledStepIds,
            customText: customText, executor: executor?.rawValue)
        return CardPipeline.appendToDescription(descriptionText, block: block)
    }

    /// `{ intake?, pipeline? }` — verbatim intake plus pipeline provenance.
    var extensionMetadata: JSONValue {
        var meta: [String: JSONValue] = [:]
        if let intake = intakeMetadata, case let .object(obj) = intake {
            meta = obj  // already contains the "intake" key
        }
        let hasPipeline = !enabledStepIds.isEmpty || executor != nil
            || !customText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if hasPipeline {
            meta["pipeline"] = .object([
                "enabledIds": .array(orderedEnabledIds.map { .string($0) }),
                "executor": executor.map { JSONValue.string($0.rawValue) } ?? .null,
                "customText": .string(customText),
            ])
        }
        return .object(meta)
    }
}
