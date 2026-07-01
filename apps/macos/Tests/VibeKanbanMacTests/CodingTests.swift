import XCTest
@testable import VibeKanbanMac

/// Covers request-body encoding (the API contract) + JSONValue + date coding.
final class CodingTests: XCTestCase {
    private let encoder = APICoding.encoder
    private let decoder = APICoding.decoder

    private func object(_ value: some Encodable) throws -> [String: Any] {
        let data = try encoder.encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Request encoding

    func testCreateIssueRequestOmitsNilButKeepsMetadata() throws {
        let req = CreateIssueRequest(projectId: "p1", statusId: "s1", title: "T", sortOrder: 5)
        let obj = try object(req)
        XCTAssertEqual(obj["project_id"] as? String, "p1")
        XCTAssertEqual(obj["status_id"] as? String, "s1")
        XCTAssertEqual(obj["title"] as? String, "T")
        XCTAssertEqual(obj["sort_order"] as? Double, 5)
        XCTAssertNotNil(obj["extension_metadata"], "extension_metadata must always be present")
        XCTAssertNil(obj["description"], "nil optionals must be omitted")
        XCTAssertNil(obj["priority"])
    }

    func testUpdateIssueRequestOnlyEncodesSetFields() throws {
        let obj = try object(UpdateIssueRequest(statusId: "s2"))
        XCTAssertEqual(obj.keys.sorted(), ["status_id"])
        XCTAssertEqual(obj["status_id"] as? String, "s2")
    }

    func testBulkIssuesRequestShape() throws {
        let req = BulkIssuesRequest(updates: [
            BulkIssueItem(id: "i1", statusId: "s2", sortOrder: 10, priority: nil, title: nil),
        ])
        let data = try encoder.encode(req)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let updates = try XCTUnwrap(obj["updates"] as? [[String: Any]])
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates[0]["id"] as? String, "i1")
        XCTAssertEqual(updates[0]["status_id"] as? String, "s2")
        XCTAssertEqual(updates[0]["sort_order"] as? Double, 10)
        XCTAssertNil(updates[0]["priority"])
        XCTAssertNil(updates[0]["title"])
    }

    func testGenerateSpecRequestShape() throws {
        let req = GenerateSpecRequest(
            projectId: "p1", brief: "do x",
            executorConfig: ExecutorConfig(executor: .codex),
            repos: [WorkspaceRepoInput(repoId: "r1", targetBranch: "main")])
        let obj = try object(req)
        XCTAssertEqual(obj["project_id"] as? String, "p1")
        XCTAssertEqual(obj["brief"] as? String, "do x")
        let exec = try XCTUnwrap(obj["executor_config"] as? [String: Any])
        XCTAssertEqual(exec["executor"] as? String, "CODEX")
        let repos = try XCTUnwrap(obj["repos"] as? [[String: Any]])
        XCTAssertEqual(repos[0]["repo_id"] as? String, "r1")
        XCTAssertEqual(repos[0]["target_branch"] as? String, "main")
    }

    // MARK: - Approval encoding

    func testApprovalOutcomeEncoding() throws {
        XCTAssertEqual(try object(ApprovalOutcome.approved)["status"] as? String, "approved")

        let denied = try object(ApprovalOutcome.denied(reason: "nope"))
        XCTAssertEqual(denied["status"] as? String, "denied")
        XCTAssertEqual(denied["reason"] as? String, "nope")

        let deniedNoReason = try object(ApprovalOutcome.denied(reason: nil))
        XCTAssertEqual(deniedNoReason["status"] as? String, "denied")
        XCTAssertNil(deniedNoReason["reason"])

        let answered = try object(ApprovalOutcome.answered(answers: [
            QuestionAnswer(question: "Q", answer: ["A", "B"]),
        ]))
        XCTAssertEqual(answered["status"] as? String, "answered")
        let answers = try XCTUnwrap(answered["answers"] as? [[String: Any]])
        XCTAssertEqual(answers[0]["question"] as? String, "Q")
        XCTAssertEqual(answers[0]["answer"] as? [String], ["A", "B"])
    }

    func testApprovalResponseShape() throws {
        let resp = ApprovalResponse(executionProcessId: "e1", status: .approved)
        let obj = try object(resp)
        XCTAssertEqual(obj["execution_process_id"] as? String, "e1")
        XCTAssertNotNil(obj["status"])
    }

    // MARK: - JSONValue

    func testJSONValueRoundTrip() throws {
        let json = #"{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}"#
        let value = try decoder.decode(JSONValue.self, from: Data(json.utf8))
        let reEncoded = try encoder.encode(value)
        let again = try decoder.decode(JSONValue.self, from: reEncoded)
        XCTAssertEqual(value, again)
    }

    func testJSONValueDisplayString() {
        XCTAssertEqual(JSONValue.number(1).displayString, "1")
        XCTAssertEqual(JSONValue.number(2.5).displayString, "2.5")
        XCTAssertEqual(JSONValue.string("hi").displayString, "hi")
        XCTAssertEqual(JSONValue.bool(true).displayString, "true")
        XCTAssertEqual(JSONValue.null.displayString, "")
    }

    // MARK: - Dates

    func testDateParsingBothFormats() {
        XCTAssertNotNil(DateParsing.parse("2024-01-01T00:00:00Z"))
        XCTAssertNotNil(DateParsing.parse("2024-01-01T00:00:00.123Z"))
        XCTAssertNil(DateParsing.parse("not-a-date"))
    }

    func testDateDecodeInModel() throws {
        let json = ##"{"id":"t1","project_id":"p1","name":"x","color":"#fff"}"##
        // Tag has no dates — sanity that fractional/plain dates decode on a dated model:
        let issueJSON = #"{"id":"i","project_id":"p","issue_number":1,"simple_id":"X-1","status_id":"s","title":"t","description":null,"priority":null,"start_date":null,"target_date":null,"completed_at":null,"sort_order":1,"parent_issue_id":null,"parent_issue_sort_order":null,"extension_metadata":{},"creator_user_id":null,"created_at":"2024-01-01T00:00:00.500Z","updated_at":"2024-01-02T00:00:00Z"}"#
        let tag = try decoder.decode(Tag.self, from: Data(json.utf8))
        XCTAssertEqual(tag.name, "x")
        let issue = try decoder.decode(Issue.self, from: Data(issueJSON.utf8))
        XCTAssertGreaterThan(issue.updatedAt, issue.createdAt)
    }
}
