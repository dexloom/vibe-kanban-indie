import Foundation

/// A single editable field in an executor's config form, distilled from the
/// draft-07 JSON Schema in `shared/schemas/<agent>.json` (the same schemas the
/// web app feeds to RJSF).
struct SchemaField: Identifiable, Equatable {
    enum Kind: Equatable {
        case text                 // string
        case textarea             // string, format: textarea
        case enumeration([String])// string with enum (null filtered out)
        case boolean              // (nullable) boolean → tri-state
        case stringArray          // array of strings
        case stringMap            // object<string,string> (e.g. env)
    }

    let name: String
    let title: String
    let description: String?
    let kind: Kind
    var id: String { name }
}

/// The parsed config schema for one executor: an ordered list of fields.
struct ExecutorSchema {
    let fields: [SchemaField]

    /// Load + parse the bundled schema for an agent (Resources/Schemas/<raw>.json).
    static func load(for agent: BaseCodingAgent, bundle: Bundle = .main) -> ExecutorSchema? {
        let file = agent.rawValue.lowercased()
        guard let url = bundle.url(forResource: file, withExtension: "json", subdirectory: "Schemas")
            ?? bundle.url(forResource: file, withExtension: "json"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return parse(data)
    }

    /// Parse a draft-07 schema document into ordered fields. Field order follows
    /// the property order in the raw JSON (RJSF renders in schema order).
    static func parse(_ data: Data) -> ExecutorSchema? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let props = root["properties"] as? [String: Any]
        else { return nil }

        let order = orderedPropertyNames(from: data, fallback: props.keys.sorted())
        var fields: [SchemaField] = []
        for name in order {
            guard let def = props[name] as? [String: Any],
                  let field = field(name: name, def: def) else { continue }
            fields.append(field)
        }
        return ExecutorSchema(fields: fields)
    }

    private static func field(name: String, def: [String: Any]) -> SchemaField? {
        let primary = primaryType(def["type"])
        let title = (def["title"] as? String) ?? prettify(name)
        let description = def["description"] as? String

        let kind: SchemaField.Kind
        switch primary {
        case "boolean":
            kind = .boolean
        case "array":
            kind = .stringArray
        case "object":
            kind = .stringMap
        case "string":
            if let raw = def["enum"] as? [Any] {
                let options = raw.compactMap { $0 as? String }
                kind = .enumeration(options)
            } else if (def["format"] as? String) == "textarea" {
                kind = .textarea
            } else {
                kind = .text
            }
        default:
            return nil
        }
        return SchemaField(name: name, title: title, description: description, kind: kind)
    }

    /// JSON Schema `type` may be a string ("boolean") or an array
    /// (["string","null"]); return the first non-null type.
    private static func primaryType(_ raw: Any?) -> String? {
        if let s = raw as? String { return s }
        if let arr = raw as? [Any] {
            return arr.compactMap { $0 as? String }.first { $0 != "null" }
        }
        return nil
    }

    /// Extract top-level property names in document order by scanning the raw JSON
    /// (Foundation's dictionary parse loses order). Falls back to `fallback` if
    /// the scan finds nothing.
    private static func orderedPropertyNames(from data: Data, fallback: [String]) -> [String] {
        guard let text = String(data: data, encoding: .utf8),
              let range = text.range(of: "\"properties\"")
        else { return fallback }
        let tail = text[range.upperBound...]
        // Top-level property keys sit at one indent level inside "properties".
        // Match `"<name>": {` lines, taking the shallowest indent that appears.
        var matches: [(indent: Int, name: String)] = []
        tail.enumerateLines { line, _ in
            guard let r = line.range(of: #"^(\s*)"([a-zA-Z0-9_]+)"\s*:\s*\{"#,
                                     options: .regularExpression) else { return }
            let matched = String(line[r])
            let indent = matched.prefix { $0 == " " }.count
            if let q1 = matched.firstIndex(of: "\""),
               let q2 = matched[matched.index(after: q1)...].firstIndex(of: "\"") {
                let name = String(matched[matched.index(after: q1)..<q2])
                matches.append((indent, name))
            }
        }
        guard let minIndent = matches.map(\.indent).min() else { return fallback }
        let ordered = matches.filter { $0.indent == minIndent }.map(\.name)
        return ordered.isEmpty ? fallback : ordered
    }

    private static func prettify(_ name: String) -> String {
        name.split(separator: "_").map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}
