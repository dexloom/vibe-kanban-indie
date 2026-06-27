import Foundation

/// Reconstructs the conversation from `normalized-logs` JSON-patch ops.
///
/// The backend streams RFC-6902 patches against a `{ entries: [...] }` document.
/// Each op targets `/entries/{index}` with a tagged value
/// `{ "type": "NORMALIZED_ENTRY"|"STDOUT"|"STDERR"|"DIFF", "content": ... }`
/// (see `crates/executors/src/logs/utils/patch.rs`). We keep entries in an
/// index→entry map and emit them sorted.
struct ConversationPatchApplier {
    private(set) var entries: [Int: NormalizedEntry] = [:]

    var sorted: [NormalizedEntry] {
        entries.sorted { $0.key < $1.key }.map(\.value)
    }

    mutating func apply(ops: [JSONValue]) {
        for op in ops {
            guard case let .object(fields) = op,
                  case let .string(opName)? = fields["op"],
                  case let .string(path)? = fields["path"],
                  let index = Self.entryIndex(from: path)
            else { continue }

            switch opName {
            case "remove":
                entries[index] = nil
            case "add", "replace":
                if let value = fields["value"], let entry = Self.entry(from: value) {
                    entries[index] = entry
                }
            default:
                break
            }
        }
    }

    private static func entryIndex(from path: String) -> Int? {
        // "/entries/3" -> 3
        guard let last = path.split(separator: "/").last else { return nil }
        return Int(last)
    }

    private static func entry(from value: JSONValue) -> NormalizedEntry? {
        guard case let .object(fields) = value,
              case let .string(type)? = fields["type"],
              let content = fields["content"]
        else { return nil }

        switch type {
        case "NORMALIZED_ENTRY":
            guard let data = try? APICoding.encoder.encode(content) else { return nil }
            return try? APICoding.decoder.decode(NormalizedEntry.self, from: data)
        case "STDOUT":
            return NormalizedEntry(timestamp: nil, entryType: .other("stdout"), content: content.displayString)
        case "STDERR":
            return NormalizedEntry(timestamp: nil, entryType: .other("stderr"), content: content.displayString)
        case "DIFF":
            return NormalizedEntry(timestamp: nil, entryType: .other("diff"), content: "📝 file changes")
        default:
            return nil
        }
    }
}
