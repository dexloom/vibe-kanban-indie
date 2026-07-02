import XCTest
@testable import VibeKanbanMac

/// Covers the terminal WS wire protocol (`TerminalCommand`/`TerminalMessage`,
/// base64 round-trip) and the reconnect backoff policy — offline, no backend.
final class TerminalProtocolTests: XCTestCase {
    // MARK: - TerminalCommand encode

    private func jsonObject(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    func testInputCommandEncodesBase64OfUTF8Bytes() throws {
        let text = "héllo\n"
        let bytes = Data(text.utf8)
        let json = try XCTUnwrap(TerminalCommand.input(bytes).encode())
        let obj = try jsonObject(json)
        XCTAssertEqual(obj["type"] as? String, "input")
        let base64 = try XCTUnwrap(obj["data"] as? String)
        XCTAssertEqual(base64, bytes.base64EncodedString())
        XCTAssertEqual(Data(base64Encoded: base64).map { String(data: $0, encoding: .utf8) } ?? nil, text)
    }

    func testResizeCommandEncodesColsAndRows() throws {
        let json = try XCTUnwrap(TerminalCommand.resize(cols: 132, rows: 43).encode())
        let obj = try jsonObject(json)
        XCTAssertEqual(obj["type"] as? String, "resize")
        XCTAssertEqual(obj["cols"] as? Int, 132)
        XCTAssertEqual(obj["rows"] as? Int, 43)
    }

    // MARK: - TerminalMessage decode

    func testOutputMessageDecodesMultiByteUTF8() throws {
        let text = "hello → bytes 🎉"
        let base64 = Data(text.utf8).base64EncodedString()
        let msg = TerminalMessage.decode(from: #"{"type":"output","data":"\#(base64)"}"#)
        guard case let .output(data) = msg else { return XCTFail("expected .output, got \(String(describing: msg))") }
        XCTAssertEqual(String(data: data, encoding: .utf8), text)
    }

    func testErrorMessageDecodesMessage() {
        let msg = TerminalMessage.decode(from: #"{"type":"error","message":"tmux session ended"}"#)
        XCTAssertEqual(msg, .error("tmux session ended"))
    }

    func testUnknownTypeDecodesNil() {
        XCTAssertNil(TerminalMessage.decode(from: #"{"type":"exit"}"#))
        XCTAssertNil(TerminalMessage.decode(from: #"{"nope":true}"#))
        XCTAssertNil(TerminalMessage.decode(from: "not json"))
    }

    func testInvalidBase64DecodesNil() {
        XCTAssertNil(TerminalMessage.decode(from: #"{"type":"output","data":"not-valid-base64!!"}"#))
    }

    func testMissingFieldsDecodeNil() {
        XCTAssertNil(TerminalMessage.decode(from: #"{"type":"output"}"#))
        XCTAssertNil(TerminalMessage.decode(from: #"{"type":"error"}"#))
    }

    // MARK: - TerminalReconnectPolicy

    func testReconnectDelaysFollowExponentialBackoffCappedAt8Seconds() {
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 0), 0.5)
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 1), 1.0)
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 2), 2.0)
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 3), 4.0)
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 4), 8.0)
        XCTAssertEqual(TerminalReconnectPolicy.delay(retry: 5), 8.0)
    }

    func testReconnectStopsAfterMaxRetries() {
        XCTAssertEqual(TerminalReconnectPolicy.maxRetries, 6)
        XCTAssertNotNil(TerminalReconnectPolicy.delay(retry: 5))
        XCTAssertNil(TerminalReconnectPolicy.delay(retry: 6))
        XCTAssertNil(TerminalReconnectPolicy.delay(retry: 7))
    }

    // MARK: - TerminalSocket URL construction

    @MainActor
    func testTerminalSocketBuildsShellURLWithoutExecutionProcessId() throws {
        let socket = try XCTUnwrap(TerminalSocket(
            base: URL(string: "http://127.0.0.1:9999")!,
            workspaceId: "w1",
            executionProcessId: nil,
            initialCols: 80,
            initialRows: 24
        ))
        let comps = try XCTUnwrap(URLComponents(url: socket.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.scheme, "ws")
        XCTAssertEqual(comps.path, "/api/terminal/ws")
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["workspace_id"] ?? nil, "w1")
        XCTAssertEqual(items["cols"] ?? nil, "80")
        XCTAssertEqual(items["rows"] ?? nil, "24")
        XCTAssertNil(items["execution_process_id"] ?? nil)
    }

    @MainActor
    func testTerminalSocketBuildsAttachURLWithExecutionProcessId() throws {
        let socket = try XCTUnwrap(TerminalSocket(
            base: URL(string: "https://example.com")!,
            workspaceId: "w1",
            executionProcessId: "e1",
            initialCols: 132,
            initialRows: 43
        ))
        let comps = try XCTUnwrap(URLComponents(url: socket.url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.scheme, "wss", "https base must map to wss")
        let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value) })
        XCTAssertEqual(items["execution_process_id"] ?? nil, "e1")
        XCTAssertEqual(items["cols"] ?? nil, "132")
        XCTAssertEqual(items["rows"] ?? nil, "43")
    }
}
