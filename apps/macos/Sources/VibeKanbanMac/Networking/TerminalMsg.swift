import Foundation

/// Client → server terminal commands, sent over `/api/terminal/ws`. Mirrors
/// Rust's externally-tagged `TerminalCommand`
/// (`crates/server/src/routes/terminal.rs`):
/// `{"type":"input","data":"<base64>"}` / `{"type":"resize","cols":N,"rows":N}`.
/// `data` is base64-encoded raw UTF-8 keystroke bytes.
enum TerminalCommand {
    case input(Data)
    case resize(cols: Int, rows: Int)

    /// The JSON text frame to send over the WebSocket, or `nil` if the frame
    /// could not be serialized (should not happen for these shapes).
    func encode() -> String? {
        let obj: [String: Any]
        switch self {
        case .input(let data):
            obj = ["type": "input", "data": data.base64EncodedString()]
        case .resize(let cols, let rows):
            obj = ["type": "resize", "cols": cols, "rows": rows]
        }
        guard let json = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: json, encoding: .utf8)
        else { return nil }
        return text
    }
}

/// Server → client terminal messages. Mirrors Rust's externally-tagged
/// `TerminalMessage`: `{"type":"output","data":"<base64>"}` /
/// `{"type":"error","message":"<str>"}`. `data` is base64-encoded raw output
/// bytes (may split multi-byte UTF-8 sequences across frames).
enum TerminalMessage: Equatable {
    case output(Data)
    case error(String)

    /// Parses a single text frame. Unknown `type`, missing fields, or invalid
    /// base64 all decode to `nil` (matches `LogMsg`'s house style).
    static func decode(from text: String) -> TerminalMessage? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String
        else { return nil }

        switch type {
        case "output":
            guard let base64 = obj["data"] as? String,
                  let bytes = Data(base64Encoded: base64)
            else { return nil }
            return .output(bytes)
        case "error":
            guard let message = obj["message"] as? String else { return nil }
            return .error(message)
        default:
            return nil
        }
    }
}
