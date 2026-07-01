import Foundation

/// A single WebSocket frame from the backend's log/patch streams. The Rust
/// `LogMsg` is externally tagged JSON: `{"Stdout":"…"}`, `{"Stderr":"…"}`,
/// `{"JsonPatch":[…ops…]}`, `{"SessionId":"…"}`, `{"Ready":true}`,
/// `{"finished":true}`. (See `crates/utils/src/log_msg.rs`.)
enum LogMsg {
    case stdout(String)
    case stderr(String)
    case jsonPatch([JSONValue])
    case sessionId(String)
    case messageId(String)
    case ready
    case finished
    case unknown

    static func decode(from text: String) -> LogMsg {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return .unknown }

        if obj["Ready"] != nil { return .ready }
        if obj["finished"] != nil || obj["Finished"] != nil { return .finished }
        if let s = obj["Stdout"] as? String { return .stdout(s) }
        if let s = obj["Stderr"] as? String { return .stderr(s) }
        if let s = obj["SessionId"] as? String { return .sessionId(s) }
        if let s = obj["MessageId"] as? String { return .messageId(s) }
        if let patch = obj["JsonPatch"],
           let patchData = try? JSONSerialization.data(withJSONObject: patch),
           let ops = try? APICoding.decoder.decode([JSONValue].self, from: patchData) {
            return .jsonPatch(ops)
        }
        return .unknown
    }
}
