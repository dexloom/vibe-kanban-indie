import SwiftUI

/// Renders an executor variant's config as an editable form, driven by the
/// bundled JSON Schema (the macOS analogue of the web app's RJSF form). Edits
/// mutate the `config` dictionary in place; an unset/empty field omits its key.
struct AgentConfigForm: View {
    let schema: ExecutorSchema
    @Binding var config: [String: JSONValue]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(schema.fields) { field in
                VStack(alignment: .leading, spacing: 3) {
                    Text(field.title).font(.subheadline.weight(.medium))
                    control(field)
                    if let d = field.description, !d.isEmpty {
                        Text(d).font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func control(_ field: SchemaField) -> some View {
        switch field.kind {
        case .text:
            TextField("", text: stringBinding(field.name)).textFieldStyle(.roundedBorder)

        case .textarea:
            TextEditor(text: stringBinding(field.name))
                .font(.callout).frame(minHeight: 56)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))

        case .enumeration(let options):
            Picker("", selection: optionalStringBinding(field.name)) {
                Text("Default").tag(String?.none)
                ForEach(options, id: \.self) { Text($0).tag(String?.some($0)) }
            }
            .labelsHidden().pickerStyle(.menu).fixedSize()

        case .boolean:
            Picker("", selection: triStateBinding(field.name)) {
                Text("Default").tag(0)
                Text("On").tag(1)
                Text("Off").tag(2)
            }
            .labelsHidden().pickerStyle(.segmented).fixedSize()

        case .stringArray:
            TextEditor(text: linesBinding(field.name))
                .font(.system(.callout, design: .monospaced)).frame(minHeight: 50)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            Text("One per line.").font(.caption2).foregroundStyle(.tertiary)

        case .stringMap:
            TextEditor(text: mapBinding(field.name))
                .font(.system(.callout, design: .monospaced)).frame(minHeight: 50)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))
            Text("One KEY=VALUE per line.").font(.caption2).foregroundStyle(.tertiary)
        }
    }

    // MARK: - Bindings (an empty/unset value omits the key)

    private func set(_ name: String, _ value: JSONValue?) {
        if let value { config[name] = value } else { config[name] = nil }
    }

    private func stringBinding(_ name: String) -> Binding<String> {
        Binding(
            get: { config[name]?.stringValue ?? "" },
            set: { set(name, $0.isEmpty ? nil : .string($0)) })
    }

    private func optionalStringBinding(_ name: String) -> Binding<String?> {
        Binding(
            get: { config[name]?.stringValue },
            set: { set(name, $0.map(JSONValue.string)) })
    }

    private func triStateBinding(_ name: String) -> Binding<Int> {
        Binding(
            get: {
                switch config[name] {
                case .bool(true): return 1
                case .bool(false): return 2
                default: return 0
                }
            },
            set: { set(name, $0 == 1 ? .bool(true) : ($0 == 2 ? .bool(false) : nil)) })
    }

    private func linesBinding(_ name: String) -> Binding<String> {
        Binding(
            get: {
                guard case let .array(items)? = config[name] else { return "" }
                return items.map(\.displayString).joined(separator: "\n")
            },
            set: { text in
                let items = text.split(separator: "\n").map { JSONValue.string(String($0).trimmingCharacters(in: .whitespaces)) }
                    .filter { $0.displayString.isEmpty == false }
                set(name, items.isEmpty ? nil : .array(items))
            })
    }

    private func mapBinding(_ name: String) -> Binding<String> {
        Binding(
            get: {
                guard case let .object(dict)? = config[name] else { return "" }
                return dict.sorted { $0.key < $1.key }
                    .map { "\($0.key)=\($0.value.displayString)" }.joined(separator: "\n")
            },
            set: { text in
                var dict: [String: JSONValue] = [:]
                for line in text.split(separator: "\n") {
                    let parts = line.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                    let key = parts.first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
                    guard !key.isEmpty else { continue }
                    let value = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
                    dict[key] = .string(value)
                }
                set(name, dict.isEmpty ? nil : .object(dict))
            })
    }
}
