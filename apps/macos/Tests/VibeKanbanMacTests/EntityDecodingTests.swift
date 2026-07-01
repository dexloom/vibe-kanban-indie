import XCTest
@testable import VibeKanbanMac

/// Decodes the remaining wire entities against representative backend JSON.
final class EntityDecodingTests: XCTestCase {
    private let decoder = APICoding.decoder

    func testDecodeExecutionWorkspace() throws {
        let json = #"{"id":"w1","task_id":null,"container_ref":"/tmp/wt","branch":"vk/feature","setup_completed_at":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z","archived":false,"pinned":true,"name":"Feature","worktree_deleted":false,"ephemeral":false,"kind":null,"is_running":true,"is_errored":false}"#
        let ws = try decoder.decode(Workspace.self, from: Data(json.utf8))
        XCTAssertEqual(ws.branch, "vk/feature")
        XCTAssertEqual(ws.displayName, "Feature")
        XCTAssertEqual(ws.isRunning, true)
        XCTAssertNil(ws.kind)
    }

    func testDecodeWorkspaceOrchestratorKind() throws {
        let json = #"{"id":"w2","task_id":null,"container_ref":null,"branch":"main","setup_completed_at":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z","archived":false,"pinned":false,"name":null,"worktree_deleted":false,"ephemeral":false,"kind":"orchestrator"}"#
        let ws = try decoder.decode(Workspace.self, from: Data(json.utf8))
        XCTAssertEqual(ws.kind, .orchestrator)
        XCTAssertEqual(ws.displayName, "main")   // falls back to branch
    }

    func testDecodeSession() throws {
        let json = #"{"id":"se1","workspace_id":"w1","name":null,"executor":"CLAUDE_CODE","agent_working_dir":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        let s = try decoder.decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(s.executor, "CLAUDE_CODE")
        XCTAssertTrue(s.displayName.hasPrefix("Session "))
    }

    func testDecodeExecutionProcess() throws {
        let json = #"{"id":"e1","session_id":"se1","run_reason":"codingagent","executor_action":{"x":1},"status":"running","exit_code":null,"dropped":false,"started_at":"2024-01-01T00:00:00Z","completed_at":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        let p = try decoder.decode(ExecutionProcess.self, from: Data(json.utf8))
        XCTAssertEqual(p.status, .running)
        XCTAssertTrue(p.status.isActive)
        XCTAssertEqual(p.runReason, .codingagent)
    }

    func testDecodeWorkspaceSummary() throws {
        let json = #"{"id":"ws","project_id":"p1","owner_user_id":"u1","issue_id":"i1","local_workspace_id":"lw1","name":"S","archived":false,"files_changed":3,"lines_added":10,"lines_removed":2,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        let s = try decoder.decode(WorkspaceSummary.self, from: Data(json.utf8))
        XCTAssertEqual(s.localWorkspaceId, "lw1")
        XCTAssertEqual(s.filesChanged, 3)
    }

    func testDecodeRepo() throws {
        let json = #"{"id":"r1","path":"/x","name":"repo","display_name":"Repo","setup_script":null,"cleanup_script":null,"archive_script":null,"copy_files":null,"parallel_setup_script":false,"dev_server_script":null,"default_target_branch":"main","default_working_dir":null,"created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}"#
        let repo = try decoder.decode(Repo.self, from: Data(json.utf8))
        XCTAssertEqual(repo.defaultTargetBranch, "main")
        XCTAssertEqual(repo.displayName, "Repo")
    }

    func testDecodeGenerateSpecResponse() throws {
        let json = #"{"title":"Spec title","description":"Spec body","intake_metadata":{"intake":{"brief":"b","repos":[]}}}"#
        let resp = try decoder.decode(GenerateSpecResponse.self, from: Data(json.utf8))
        XCTAssertEqual(resp.title, "Spec title")
        guard case let .object(meta) = resp.intakeMetadata else { return XCTFail("object") }
        XCTAssertNotNil(meta["intake"])
    }

    func testDecodeAvailabilityInfoVariants() throws {
        func info(_ json: String) throws -> AvailabilityInfo {
            try decoder.decode(AvailabilityInfo.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try info(#"{"type":"INSTALLATION_FOUND"}"#), .installationFound)
        XCTAssertEqual(try info(#"{"type":"NOT_FOUND"}"#), .notFound)
        XCTAssertTrue(try info(#"{"type":"LOGIN_DETECTED","last_auth_timestamp":123}"#).available)
        XCTAssertFalse(try info(#"{"type":"NOT_FOUND"}"#).available)
        XCTAssertEqual(try info(#"{"type":"WEIRD"}"#), .unknown)
    }

    func testApiResponseEnvelopeUnwrapAndEmpty() throws {
        let ok = try decoder.decode(ApiResponse<[Session]>.self,
                                    from: Data(#"{"success":true,"data":[],"error_data":null,"message":null}"#.utf8))
        XCTAssertEqual(ok.data?.count, 0)
        let empty = try decoder.decode(ApiResponse<Session>.self,
                                       from: Data(#"{"success":false,"data":null,"error_data":null,"message":"boom"}"#.utf8))
        XCTAssertNil(empty.data)
        XCTAssertEqual(empty.message, "boom")
    }

    func testMutationResponse() throws {
        let json = ##"{"data":{"id":"t1","project_id":"p1","name":"x","color":"#fff"},"txid":42}"##
        let m = try decoder.decode(MutationResponse<Tag>.self, from: Data(json.utf8))
        XCTAssertEqual(m.data.id, "t1")
        XCTAssertEqual(m.txid, 42)
    }

    func testDecodeApprovalOutcomeRoundTrip() throws {
        let data = try APICoding.encoder.encode(ApprovalOutcome.answered(answers: [
            QuestionAnswer(question: "Q", answer: ["x"]),
        ]))
        let decoded = try decoder.decode(ApprovalOutcome.self, from: data)
        XCTAssertEqual(decoded, .answered(answers: [QuestionAnswer(question: "Q", answer: ["x"])]))
    }
}
