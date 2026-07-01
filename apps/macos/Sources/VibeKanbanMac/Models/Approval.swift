import Foundation

/// A pending approval/question from a running agent. Mirrors `shared/types.ts`
/// `ApprovalInfo`; served by `/approvals/pending/{execution_process_id}` and
/// streamed from `/approvals/stream/ws`.
struct ApprovalInfo: Codable, Identifiable, Hashable {
    let approvalId: String
    let toolName: String
    let executionProcessId: String
    let isQuestion: Bool
    let kind: ApprovalKind
    let toolUseId: String?
    let questions: [ApprovalQuestion]?
    let planContent: String?
    let createdAt: Date
    let timeoutAt: Date

    var id: String { approvalId }

    enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id"
        case toolName = "tool_name"
        case executionProcessId = "execution_process_id"
        case isQuestion = "is_question"
        case kind
        case toolUseId = "tool_use_id"
        case questions
        case planContent = "plan_content"
        case createdAt = "created_at"
        case timeoutAt = "timeout_at"
    }
}

enum ApprovalKind: String, Codable, Hashable {
    case tool
    case question
    case planApproval = "plan_approval"
}

struct ApprovalQuestion: Codable, Hashable, Identifiable {
    let question: String
    let header: String?
    let options: [ApprovalQuestionOption]
    let multiSelect: Bool

    var id: String { question }
}

struct ApprovalQuestionOption: Codable, Hashable, Identifiable {
    let label: String
    let description: String?

    var id: String { label }
}

// MARK: - Response

struct QuestionAnswer: Codable, Hashable {
    let question: String
    let answer: [String]
}

/// Tagged outcome sent back to the agent. Encodes as `{ "status": "..." }`.
enum ApprovalOutcome: Codable, Hashable {
    case approved
    case denied(reason: String?)
    case answered(answers: [QuestionAnswer])
    case timedOut

    private enum CodingKeys: String, CodingKey { case status, reason, answers }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .approved:
            try c.encode("approved", forKey: .status)
        case .denied(let reason):
            try c.encode("denied", forKey: .status)
            try c.encodeIfPresent(reason, forKey: .reason)
        case .answered(let answers):
            try c.encode("answered", forKey: .status)
            try c.encode(answers, forKey: .answers)
        case .timedOut:
            try c.encode("timed_out", forKey: .status)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .status) {
        case "approved": self = .approved
        case "denied": self = .denied(reason: try? c.decode(String.self, forKey: .reason))
        case "answered": self = .answered(answers: (try? c.decode([QuestionAnswer].self, forKey: .answers)) ?? [])
        default: self = .timedOut
        }
    }
}

/// `POST /approvals/{approval_id}/respond` body.
struct ApprovalResponse: Codable {
    let executionProcessId: String
    let status: ApprovalOutcome

    enum CodingKeys: String, CodingKey {
        case executionProcessId = "execution_process_id"
        case status
    }
}
