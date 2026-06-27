import XCTest
@testable import VibeKanbanMac

/// Decodes JSON shaped like the live backend wire format to guard the Codable
/// models against drift. Samples mirror `/v1/fallback/*`, `/approvals/*`, and
/// the normalized-logs patch stream.
final class ModelDecodingTests: XCTestCase {
    private let decoder = APICoding.decoder

    func testDecodeProject() throws {
        let json = """
        {"id":"p1","organization_id":"o1","name":"Demo","color":"#5B73F2",
         "sort_order":1000,"created_at":"2024-01-01T00:00:00Z",
         "updated_at":"2024-01-01T00:00:00.123Z"}
        """.data(using: .utf8)!
        let project = try decoder.decode(Project.self, from: json)
        XCTAssertEqual(project.name, "Demo")
        XCTAssertEqual(project.organizationId, "o1")
    }

    func testDecodeProjectStatus() throws {
        let json = """
        {"id":"s1","project_id":"p1","name":"To Do","color":"#888",
         "sort_order":1,"hidden":false,"created_at":"2024-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        let status = try decoder.decode(ProjectStatus.self, from: json)
        XCTAssertFalse(status.hidden)
        XCTAssertEqual(status.name, "To Do")
    }

    func testDecodeIssue() throws {
        let json = """
        {"id":"i1","project_id":"p1","issue_number":42,"simple_id":"DEMO-42",
         "status_id":"s1","title":"Build it","description":"do the thing",
         "priority":"high","start_date":null,"target_date":null,"completed_at":null,
         "sort_order":2000.5,"parent_issue_id":null,"parent_issue_sort_order":null,
         "extension_metadata":{},"creator_user_id":null,
         "created_at":"2024-01-01T00:00:00Z","updated_at":"2024-01-01T00:00:00Z"}
        """.data(using: .utf8)!
        let issue = try decoder.decode(Issue.self, from: json)
        XCTAssertEqual(issue.simpleId, "DEMO-42")
        XCTAssertEqual(issue.priority, .high)
        XCTAssertEqual(issue.sortOrder, 2000.5, accuracy: 0.001)
    }

    func testDecodeFallbackEnvelope() throws {
        let json = #"{"issues":[]}"#.data(using: .utf8)!
        let response = try decoder.decode(IssuesResponse.self, from: json)
        XCTAssertTrue(response.issues.isEmpty)
    }

    func testDecodeApiResponseEnvelope() throws {
        let json = #"{"success":true,"data":[],"error_data":null,"message":null}"#.data(using: .utf8)!
        let env = try decoder.decode(ApiResponse<[Workspace]>.self, from: json)
        XCTAssertEqual(env.data?.count, 0)
    }

    func testDecodeApprovalQuestion() throws {
        let json = """
        {"approval_id":"a1","tool_name":"AskUserQuestion","execution_process_id":"e1",
         "is_question":true,"kind":"question","questions":[
            {"question":"Pick one","header":"Choice","multiSelect":false,
             "options":[{"label":"A","description":"first"},{"label":"B"}]}],
         "created_at":"2024-01-01T00:00:00Z","timeout_at":"2024-01-01T10:00:00Z"}
        """.data(using: .utf8)!
        let approval = try decoder.decode(ApprovalInfo.self, from: json)
        XCTAssertEqual(approval.kind, .question)
        XCTAssertEqual(approval.questions?.first?.options.count, 2)
    }

    func testApprovalOutcomeEncoding() throws {
        let data = try APICoding.encoder.encode(ApprovalOutcome.approved)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(object?["status"] as? String, "approved")
    }

    func testLogMsgDecodeStdout() {
        guard case .stdout(let s) = LogMsg.decode(from: #"{"Stdout":"hello"}"#) else {
            return XCTFail("expected stdout")
        }
        XCTAssertEqual(s, "hello")
    }

    func testConversationPatchApplier() {
        let frame = #"""
        {"JsonPatch":[{"op":"add","path":"/entries/0","value":{"type":"NORMALIZED_ENTRY","content":{"timestamp":null,"entry_type":{"type":"assistant_message"},"content":"hi there"}}}]}
        """#
        guard case .jsonPatch(let ops) = LogMsg.decode(from: frame) else {
            return XCTFail("expected json patch")
        }
        var applier = ConversationPatchApplier()
        applier.apply(ops: ops)
        XCTAssertEqual(applier.sorted.count, 1)
        XCTAssertEqual(applier.sorted.first?.content, "hi there")
        XCTAssertEqual(applier.sorted.first?.entryType, .assistantMessage)
    }
}
