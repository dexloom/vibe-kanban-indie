import Foundation

/// One normalized log entry from the agent transcript. Mirrors
/// `shared/types.ts` `NormalizedEntry`; streamed from
/// `/execution-processes/{id}/normalized-logs/ws`.
struct NormalizedEntry: Codable, Hashable, Identifiable {
    let id = UUID()
    let timestamp: Date?
    let entryType: NormalizedEntryKind
    let content: String

    enum CodingKeys: String, CodingKey {
        case timestamp
        case entryType = "entry_type"
        case content
    }
}

/// Simplified view of `NormalizedEntryType` covering the variants the chat
/// renders; anything unknown falls back to `.other`.
enum NormalizedEntryKind: Codable, Hashable {
    case userMessage
    case userFeedback(deniedTool: String)
    case assistantMessage
    case toolUse(toolName: String, status: ToolStatusKind)
    case systemMessage
    case errorMessage
    case thinking
    case loading
    case turnComplete
    case tokenUsage
    case other(String)

    private enum CodingKeys: String, CodingKey {
        case type
        case denied_tool
        case tool_name
        case status
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type)) ?? "other"
        switch type {
        case "user_message": self = .userMessage
        case "assistant_message": self = .assistantMessage
        case "system_message": self = .systemMessage
        case "thinking": self = .thinking
        case "loading": self = .loading
        case "turn_complete": self = .turnComplete
        case "error_message": self = .errorMessage
        case "token_usage_info": self = .tokenUsage
        case "user_feedback":
            self = .userFeedback(deniedTool: (try? c.decode(String.self, forKey: .denied_tool)) ?? "")
        case "tool_use":
            let name = (try? c.decode(String.self, forKey: .tool_name)) ?? "tool"
            let status = (try? c.decode(ToolStatusKind.self, forKey: .status)) ?? .other
            self = .toolUse(toolName: name, status: status)
        default:
            self = .other(type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(typeString, forKey: .type)
    }

    var typeString: String {
        switch self {
        case .userMessage: return "user_message"
        case .userFeedback: return "user_feedback"
        case .assistantMessage: return "assistant_message"
        case .toolUse: return "tool_use"
        case .systemMessage: return "system_message"
        case .errorMessage: return "error_message"
        case .thinking: return "thinking"
        case .loading: return "loading"
        case .turnComplete: return "turn_complete"
        case .tokenUsage: return "token_usage_info"
        case .other(let t): return t
        }
    }
}

/// Status of a tool-use entry (subset of `ToolStatus`).
enum ToolStatusKind: Codable, Hashable {
    case created, success, failed, denied, pendingApproval(approvalId: String), timedOut, other

    private enum CodingKeys: String, CodingKey { case status, approval_id }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch (try? c.decode(String.self, forKey: .status)) ?? "" {
        case "created": self = .created
        case "success": self = .success
        case "failed": self = .failed
        case "denied": self = .denied
        case "timed_out": self = .timedOut
        case "pending_approval":
            self = .pendingApproval(approvalId: (try? c.decode(String.self, forKey: .approval_id)) ?? "")
        default: self = .other
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let s: String
        switch self {
        case .created: s = "created"
        case .success: s = "success"
        case .failed: s = "failed"
        case .denied: s = "denied"
        case .timedOut: s = "timed_out"
        case .pendingApproval(let id):
            s = "pending_approval"; try c.encode(id, forKey: .approval_id)
        case .other: s = "other"
        }
        try c.encode(s, forKey: .status)
    }
}

struct TodoItem: Codable, Hashable {
    let content: String
    let status: String
    let priority: String?
}
