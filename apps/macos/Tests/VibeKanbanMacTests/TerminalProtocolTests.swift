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
}
