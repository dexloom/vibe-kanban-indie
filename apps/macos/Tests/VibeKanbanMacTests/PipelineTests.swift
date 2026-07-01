import XCTest
@testable import VibeKanbanMac

/// Covers the `## Pipeline` markdown composer and the issue composer model's
/// description + extension_metadata building.
final class PipelineTests: XCTestCase {

    // MARK: - CardPipeline

    func testExecutorLine() {
        XCTAssertEqual(CardPipeline.executorLine(nil), "")
        XCTAssertEqual(CardPipeline.executorLine("   "), "")
        XCTAssertEqual(
            CardPipeline.executorLine("CODEX"),
            "- Run this card with the **CODEX** execution agent: pass `executor: \"CODEX\"` when starting the workspace.")
    }

    func testComposeBlockEmptyWhenNothingSelected() {
        let block = CardPipeline.composeBlock(
            steps: PipelineStep.defaults, enabledIds: [], customText: "", executor: nil)
        XCTAssertEqual(block, "")
    }

    func testComposeBlockOrderingAndDelimiters() {
        let block = CardPipeline.composeBlock(
            steps: PipelineStep.defaults,
            enabledIds: ["spec"],
            customText: "",
            executor: "CLAUDE_CODE")
        XCTAssertTrue(block.hasPrefix(CardPipeline.start))
        XCTAssertTrue(block.hasSuffix(CardPipeline.end))
        XCTAssertTrue(block.contains("## Pipeline"))
        // Executor directive must lead the bullets.
        let execIdx = block.range(of: "execution agent")!.lowerBound
        let specIdx = block.range(of: "SPEC.md")!.lowerBound
        XCTAssertLessThan(execIdx, specIdx)
    }

    func testComposeBlockCustomTextOnly() {
        let block = CardPipeline.composeBlock(
            steps: PipelineStep.defaults, enabledIds: [], customText: "do the thing", executor: nil)
        XCTAssertTrue(block.contains("do the thing"))
        XCTAssertTrue(block.contains("## Pipeline"))
    }

    func testAppendIsIdempotent() {
        let block = CardPipeline.composeBlock(
            steps: PipelineStep.defaults, enabledIds: ["plan"], customText: "", executor: "CODEX")
        let once = CardPipeline.appendToDescription("Base prose.", block: block)
        let twice = CardPipeline.appendToDescription(once, block: block)
        XCTAssertEqual(once, twice, "re-appending must not stack duplicate blocks")
        XCTAssertTrue(once.hasPrefix("Base prose."))
        XCTAssertEqual(once.components(separatedBy: CardPipeline.start).count - 1, 1)
    }

    func testAppendEmptyBlockStripsExisting() {
        let block = CardPipeline.composeBlock(
            steps: PipelineStep.defaults, enabledIds: ["pr"], customText: "", executor: nil)
        let withBlock = CardPipeline.appendToDescription("Prose.", block: block)
        let stripped = CardPipeline.appendToDescription(withBlock, block: "")
        XCTAssertEqual(stripped, "Prose.")
    }

    func testDefaultStepCatalog() {
        let ids = PipelineStep.defaults.map(\.id)
        XCTAssertEqual(ids, [
            "orchestrate", "spec", "plan", "plan-review", "wait-for-approval",
            "code-review", "update-docs", "merge", "pr",
        ])
        XCTAssertTrue(PipelineStep.defaults.allSatisfy { !$0.label.isEmpty && !$0.promptFragment.isEmpty })
    }

    // MARK: - IssueComposerModel

    @MainActor
    private func makeComposer() -> IssueComposerModel {
        let client = APIClient(baseURL: URL(string: "http://127.0.0.1:0")!)
        let statuses = [
            ProjectStatus(id: "s1", projectId: "p1", name: "Todo", color: "#888",
                          sortOrder: 1, hidden: false, createdAt: Date()),
        ]
        let project = Project(id: "p1", organizationId: "o1", name: "Demo", color: "#fff",
                              sortOrder: 1, createdAt: Date(), updatedAt: Date())
        return IssueComposerModel(project: project, statuses: statuses, client: client, initialStatusId: "s1")
    }

    @MainActor
    func testComposerFinalDescriptionAppendsPipeline() {
        let model = makeComposer()
        model.descriptionText = "Original."
        model.executor = .codex
        model.enabledStepIds = ["spec"]
        let desc = model.finalDescription
        XCTAssertTrue(desc.hasPrefix("Original."))
        XCTAssertTrue(desc.contains("## Pipeline"))
        XCTAssertTrue(desc.contains("**CODEX**"))
    }

    @MainActor
    func testComposerExtensionMetadataPipeline() {
        let model = makeComposer()
        model.executor = .claudeCode
        model.enabledStepIds = ["plan", "spec"]   // out of catalog order on purpose
        model.customText = "extra"
        guard case let .object(meta) = model.extensionMetadata,
              case let .object(pipeline)? = meta["pipeline"] else {
            return XCTFail("expected pipeline object")
        }
        XCTAssertEqual(pipeline["executor"], .string("CLAUDE_CODE"))
        XCTAssertEqual(pipeline["customText"], .string("extra"))
        // enabledIds preserved in catalog order: spec before plan.
        XCTAssertEqual(pipeline["enabledIds"], .array([.string("spec"), .string("plan")]))
    }

    @MainActor
    func testComposerEmptyMetadataWhenNothingSelected() {
        let model = makeComposer()
        XCTAssertEqual(model.extensionMetadata, .object([:]))
    }

    @MainActor
    func testComposerExecutorConfig() {
        let model = makeComposer()
        model.executor = .gemini
        model.modelId = "  some/model  "
        XCTAssertEqual(model.executorConfig.executor, .gemini)
        XCTAssertEqual(model.executorConfig.modelId, "some/model")

        let blank = makeComposer()
        XCTAssertEqual(blank.executorConfig.executor, .claudeCode)
        XCTAssertNil(blank.executorConfig.modelId)
    }

    @MainActor
    func testComposerCanSubmit() {
        let model = makeComposer()
        XCTAssertFalse(model.canSubmit)
        model.title = "   "
        XCTAssertFalse(model.canSubmit)
        model.title = "Real title"
        XCTAssertTrue(model.canSubmit)
    }
}
