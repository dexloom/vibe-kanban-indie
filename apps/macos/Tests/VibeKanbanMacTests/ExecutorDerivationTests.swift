import XCTest
@testable import VibeKanbanMac

/// Covers `executor_action` walk + interactive detection + follow-up executor
/// precedence — the macOS port of `packages/web-core/src/shared/lib/executor.ts`
/// and `interactive.ts`.
final class ExecutorDerivationTests: XCTestCase {
    private let decoder = APICoding.decoder

    private func process(_ json: String) throws -> ExecutionProcess {
        try decoder.decode(ExecutionProcess.self, from: Data(json.utf8))
    }

    private func processJSON(
        id: String = "e1",
        status: String = "running",
        runReason: String = "codingagent",
        executorAction: String
    ) -> String {
        #"""
        {"id":"\#(id)","session_id":"se1","run_reason":"\#(runReason)","executor_action":\#(executorAction),"status":"\#(status)","exit_code":null,"dropped":false,"started_at":"2024-01-01T00:00:00Z","completed_at":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}
        """#
    }

    // MARK: - derivedExecutorConfig

    func testDerivedExecutorConfigFromInitialRequestWithInteractive() throws {
        let json = processJSON(executorAction: #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"CODEX"},"interactive":{"session_uuid":"11111111-1111-1111-1111-111111111111","terminal":"NONE"}},"next_action":null}
            """#)
        let p = try process(json)
        XCTAssertEqual(p.derivedExecutorConfig?.executor, .codex)
        XCTAssertTrue(p.hasInteractiveConfig)
    }

    func testDerivedExecutorConfigWalksNextActionPastScriptRequest() throws {
        let json = processJSON(runReason: "setupscript", executorAction: #"""
            {"typ":{"type":"ScriptRequest","script":"echo hi"},"next_action":{"typ":{"type":"CodingAgentFollowUpRequest","prompt":"hi","session_id":"claude-1","executor_config":{"executor":"AMP"}},"next_action":null}}
            """#)
        let p = try process(json)
        XCTAssertEqual(p.derivedExecutorConfig?.executor, .amp)
    }

    func testHasInteractiveConfigFalseWhenInteractiveIsNull() throws {
        let json = processJSON(executorAction: #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"CLAUDE_CODE"},"interactive":null},"next_action":null}
            """#)
        let p = try process(json)
        XCTAssertFalse(p.hasInteractiveConfig)
    }

    func testHasInteractiveConfigFalseWhenInteractiveAbsent() throws {
        let json = processJSON(executorAction: #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"CLAUDE_CODE"}},"next_action":null}
            """#)
        let p = try process(json)
        XCTAssertFalse(p.hasInteractiveConfig)
    }

    func testHasInteractiveConfigFalseForNonCodingAgentAction() throws {
        let json = processJSON(runReason: "setupscript", executorAction: #"""
            {"typ":{"type":"ScriptRequest","script":"echo hi"},"next_action":null}
            """#)
        let p = try process(json)
        XCTAssertFalse(p.hasInteractiveConfig)
        XCTAssertNil(p.derivedExecutorConfig)
    }

    func testDerivedExecutorConfigNilWhenExecutorActionMissing() throws {
        let json = #"{"id":"e1","session_id":"se1","run_reason":"codingagent","executor_action":null,"status":"running","exit_code":null,"dropped":false,"started_at":"2024-01-01T00:00:00Z","completed_at":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        let p = try process(json)
        XCTAssertNil(p.derivedExecutorConfig)
        XCTAssertFalse(p.hasInteractiveConfig)
    }

    // MARK: - isLiveInteractiveCodingAgent

    func testIsLiveInteractiveCodingAgentRequiresRunningCodingAgentAndInteractive() throws {
        let interactiveAction = #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"CLAUDE_CODE_HEADED"},"interactive":{"session_uuid":"11111111-1111-1111-1111-111111111111","terminal":"NONE"}},"next_action":null}
            """#
        let running = try process(processJSON(status: "running", runReason: "codingagent", executorAction: interactiveAction))
        XCTAssertTrue(running.isLiveInteractiveCodingAgent)

        let completed = try process(processJSON(status: "completed", runReason: "codingagent", executorAction: interactiveAction))
        XCTAssertFalse(completed.isLiveInteractiveCodingAgent, "finished execution is not live")

        let headless = try process(processJSON(status: "running", runReason: "codingagent", executorAction: #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"CLAUDE_CODE"}},"next_action":null}
            """#))
        XCTAssertFalse(headless.isLiveInteractiveCodingAgent, "headless (non-interactive) execution is not attachable")

        let nonCodingAgent = try process(processJSON(status: "running", runReason: "devserver", executorAction: interactiveAction))
        XCTAssertFalse(nonCodingAgent.isLiveInteractiveCodingAgent, "dev server is not a coding agent")
    }

    // MARK: - deriveExecutorConfig precedence

    private func session(id: String = "s1", executor: String?) -> Session {
        let json = #"{"id":"\#(id)","workspace_id":"w1","name":null,"executor":\#(executor.map { "\"\($0)\"" } ?? "null"),"agent_working_dir":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        return try! decoder.decode(Session.self, from: Data(json.utf8))
    }

    func testDeriveExecutorConfigPrefersNewestExecutionOverSessionMetadata() throws {
        let older = try process(processJSON(id: "e1", executorAction: #"""
            {"typ":{"type":"CodingAgentInitialRequest","executor_config":{"executor":"GEMINI"}},"next_action":null}
            """#))
        let newer = try process(processJSON(id: "e2", executorAction: #"""
            {"typ":{"type":"CodingAgentFollowUpRequest","prompt":"p","session_id":"s","executor_config":{"executor":"CODEX"}},"next_action":null}
            """#))
        let s = session(executor: "CLAUDE_CODE")
        let config = deriveExecutorConfig(executions: [older, newer], session: s, fallbackSessions: [s])
        XCTAssertEqual(config?.executor, .codex, "newest execution (last in oldest-first list) wins")
    }

    func testDeriveExecutorConfigFallsBackToSessionExecutorWhenNoExecutions() {
        let s = session(executor: "OPENCODE")
        let config = deriveExecutorConfig(executions: [], session: s, fallbackSessions: [s])
        XCTAssertEqual(config?.executor, .opencode)
    }

    func testDeriveExecutorConfigFallsBackToFallbackSessionsForBrandNewSession() {
        let last = session(id: "s0", executor: "CURSOR_AGENT")
        let config = deriveExecutorConfig(executions: [], session: nil, fallbackSessions: [last])
        XCTAssertEqual(config?.executor, .cursorAgent)
    }

    func testDeriveExecutorConfigNilWhenNothingToDeriveFrom() {
        let config = deriveExecutorConfig(executions: [], session: nil, fallbackSessions: [])
        XCTAssertNil(config)
    }
}
