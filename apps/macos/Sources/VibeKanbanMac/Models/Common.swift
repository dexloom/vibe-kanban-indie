import Foundation

// MARK: - JSON coding helpers

/// Shared JSON encoder/decoder configured to match the Rust backend's wire
/// format. Timestamps are ISO-8601 strings (sometimes with fractional seconds);
/// we decode both shapes. IDs are kept as plain `String` so we never fail on a
/// non-canonical value.
enum APICoding {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = DateParsing.parse(raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Unrecognized date: \(raw)")
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(DateParsing.isoWithFraction.string(from: date))
        }
        return e
    }()
}

enum DateParsing {
    static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        isoWithFraction.date(from: raw) ?? isoPlain.date(from: raw)
    }
}

// MARK: - JSONValue

/// A loosely-typed JSON value used for fields the sketch does not fully model
/// (e.g. `extension_metadata`, `executor_action`, tool arguments/results).
indirect enum JSONValue: Codable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([JSONValue].self) {
            self = .array(v)
        } else if let v = try? c.decode([String: JSONValue].self) {
            self = .object(v)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    /// Best-effort string for display.
    var displayString: String {
        switch self {
        case .null: return ""
        case .bool(let v): return String(v)
        case .number(let v): return v == v.rounded() ? String(Int(v)) : String(v)
        case .string(let v): return v
        case .array(let a): return a.map(\.displayString).joined(separator: ", ")
        case .object: return "{…}"
        }
    }
}

// MARK: - Mutation envelopes

/// `{ data, txid }` returned by every `/v1/*` mutation.
struct MutationResponse<T: Codable>: Codable {
    let data: T
    let txid: Int64?
}

struct DeleteResponse: Codable {
    let txid: Int64?
}

/// `{ success, data, error_data, message }` envelope used by the execution APIs
/// (`/approvals/*`, `/kanban/*`, …). See `crates/utils/src/response.rs`.
/// Decode-only (we never send this shape).
struct ApiResponse<T: Decodable>: Decodable {
    let success: Bool
    let data: T?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case success, data, message
        // `error_data` intentionally ignored.
    }
}
