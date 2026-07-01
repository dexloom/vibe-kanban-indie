import XCTest
@testable import VibeKanbanMac

/// Covers LogMsg frame decoding + the conversation patch applier.
final class ConversationTests: XCTestCase {

    private func ops(_ json: String) -> [JSONValue] {
        guard case .jsonPatch(let ops) = LogMsg.decode(from: json) else {
            XCTFail("expected json patch frame"); return []
        }
        return ops
    }

    func testLogMsgVariants() {
        if case .stdout(let s) = LogMsg.decode(from: #"{"Stdout":"out"}"#) { XCTAssertEqual(s, "out") }
        else { XCTFail("stdout") }
        if case .stderr(let s) = LogMsg.decode(from: #"{"Stderr":"err"}"#) { XCTAssertEqual(s, "err") }
        else { XCTFail("stderr") }
        if case .sessionId(let s) = LogMsg.decode(from: #"{"SessionId":"abc"}"#) { XCTAssertEqual(s, "abc") }
        else { XCTFail("sessionId") }
        if case .ready = LogMsg.decode(from: #"{"Ready":true}"#) {} else { XCTFail("ready") }
        if case .finished = LogMsg.decode(from: #"{"finished":true}"#) {} else { XCTFail("finished") }
        if case .unknown = LogMsg.decode(from: "not json") {} else { XCTFail("unknown") }
    }

    func testApplyAddNormalizedEntry() {
        var applier = ConversationPatchApplier()
        applier.apply(ops: ops(#"""
        {"JsonPatch":[{"op":"add","path":"/entries/0","value":{"type":"NORMALIZED_ENTRY","content":{"timestamp":null,"entry_type":{"type":"assistant_message"},"content":"hi"}}}]}
        """#))
        XCTAssertEqual(applier.sorted.count, 1)
        XCTAssertEqual(applier.sorted.first?.entryType, .assistantMessage)
        XCTAssertEqual(applier.sorted.first?.content, "hi")
    }

    func testApplyOrdersByIndex() {
        var applier = ConversationPatchApplier()
        for (i, text) in [(2, "third"), (0, "first"), (1, "second")] {
            applier.apply(ops: ops("""
            {"JsonPatch":[{"op":"add","path":"/entries/\(i)","value":{"type":"NORMALIZED_ENTRY","content":{"timestamp":null,"entry_type":{"type":"system_message"},"content":"\(text)"}}}]}
            """))
        }
        XCTAssertEqual(applier.sorted.map(\.content), ["first", "second", "third"])
    }

    func testReplaceAndRemove() {
        var applier = ConversationPatchApplier()
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"add","path":"/entries/0","value":{"type":"NORMALIZED_ENTRY","content":{"timestamp":null,"entry_type":{"type":"assistant_message"},"content":"v1"}}}]}"#))
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"replace","path":"/entries/0","value":{"type":"NORMALIZED_ENTRY","content":{"timestamp":null,"entry_type":{"type":"assistant_message"},"content":"v2"}}}]}"#))
        XCTAssertEqual(applier.sorted.first?.content, "v2")
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"remove","path":"/entries/0"}]}"#))
        XCTAssertTrue(applier.sorted.isEmpty)
    }

    func testStdoutAndDiffPatchTypes() {
        var applier = ConversationPatchApplier()
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"add","path":"/entries/0","value":{"type":"STDOUT","content":"line of output"}}]}"#))
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"add","path":"/entries/1","value":{"type":"DIFF","content":{"foo":"bar"}}}]}"#))
        XCTAssertEqual(applier.sorted[0].entryType, .other("stdout"))
        XCTAssertEqual(applier.sorted[0].content, "line of output")
        XCTAssertEqual(applier.sorted[1].entryType, .other("diff"))
    }

    func testMalformedOpsAreIgnored() {
        var applier = ConversationPatchApplier()
        applier.apply(ops: ops(#"{"JsonPatch":[{"op":"add"},{"path":"/entries/0"},{"op":"add","path":"/nope/0","value":{"type":"STDOUT","content":"x"}}]}"#))
        XCTAssertTrue(applier.sorted.isEmpty)
    }

    func testToolUseAndStatusDecoding() throws {
        let json = #"{"timestamp":null,"entry_type":{"type":"tool_use","tool_name":"Bash","action_type":{"action":"other","description":"x"},"status":{"status":"pending_approval","approval_id":"ap1"}},"content":"running"}"#
        let entry = try APICoding.decoder.decode(NormalizedEntry.self, from: Data(json.utf8))
        guard case let .toolUse(name, status) = entry.entryType else { return XCTFail("tool_use") }
        XCTAssertEqual(name, "Bash")
        XCTAssertEqual(status, .pendingApproval(approvalId: "ap1"))
    }

    func testUnknownEntryTypeFallsBack() throws {
        let json = #"{"timestamp":null,"entry_type":{"type":"brand_new_kind"},"content":"x"}"#
        let entry = try APICoding.decoder.decode(NormalizedEntry.self, from: Data(json.utf8))
        XCTAssertEqual(entry.entryType, .other("brand_new_kind"))
    }
}
