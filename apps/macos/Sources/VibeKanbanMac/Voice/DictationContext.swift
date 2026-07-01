import Foundation

/// Which Voicy surface the mic opens. `agent` → Voicy's Agents section (a Voicy
/// agent prepares the reply); `task` → Voicy's Voice→Coding Task composer.
enum DictationMode: String {
    case agent
    case task
}

/// The vibe-kanban situation a dictation is for. It drives **which Voicy surface
/// opens** and **which Voicy agent is selected** (via the user's situation→agent
/// mapping in `VoiceAgentMap`).
enum DictationSituation: String, CaseIterable, Identifiable {
    case instruction    // a follow-up instruction to the coding agent
    case questionnaire  // answering an AskUserQuestion / plan questionnaire
    case review         // reviewing a diff / responding to an approval
    case task           // building a card / spec

    var id: String { rawValue }

    /// The Voicy surface this situation opens. Only agent-surface situations use
    /// the situation→agent mapping; `task` goes to the Task composer.
    var mode: DictationMode { self == .task ? .task : .agent }

    /// The Voicy agent this situation targets by default — the bundled
    /// "vibe-kanban" agent for the agent-surface situations, none for `task`.
    var defaultAgentId: String? { mode == .agent ? VoiceAgentMap.vibeKanbanAgentId : nil }

    /// Short label for the mic menu.
    var title: String {
        switch self {
        case .instruction:   return "Instruction"
        case .questionnaire: return "Answer questionnaire"
        case .review:        return "Review / approve"
        case .task:          return "Task"
        }
    }

    /// Full label for the app-menu command.
    var menuLabel: String {
        switch self {
        case .instruction:   return "Dictate Instruction with Voicy"
        case .questionnaire: return "Dictate Questionnaire Answer with Voicy"
        case .review:        return "Dictate Review with Voicy"
        case .task:          return "Dictate Task with Voicy"
        }
    }
}

/// Persistent mapping of dictation situation → Voicy agent id, chosen by the user
/// in Settings → Voice. Empty/missing means "use Voicy's active agent". Stored in
/// `UserDefaults`.
enum VoiceAgentMap {
    /// The Voicy agent (seeded by Voicy) that handles vibe-kanban's agent-mode
    /// situations: instruction / answer questionnaire / review-approve.
    static let vibeKanbanAgentId = "vibe-kanban"

    private static func key(_ situation: DictationSituation) -> String {
        "voiceAgent.\(situation.rawValue)"
    }

    /// The configured agent for `situation`. If the user has never chosen one,
    /// falls back to the situation's default (the `vibe-kanban` agent). An
    /// explicit empty choice ("Voicy's active agent") is preserved as `nil`.
    static func agentId(for situation: DictationSituation) -> String? {
        if UserDefaults.standard.object(forKey: key(situation)) != nil {
            let value = UserDefaults.standard.string(forKey: key(situation)) ?? ""
            return value.isEmpty ? nil : value
        }
        return situation.defaultAgentId
    }

    static func setAgentId(_ id: String?, for situation: DictationSituation) {
        UserDefaults.standard.set(id ?? "", forKey: key(situation))
    }
}

/// Conversation context sent to Voicy to bias transcription for accuracy.
///
/// Encoded with default (camelCase) keys to match Voicy's `DictationContextDTO`.
/// Voicy turns this into a recognition glossary (project/agent names, identifiers
/// from the title, and the recent conversation) so technical vocabulary is
/// transcribed correctly.
struct DictationContext: Codable, Equatable {
    /// Which input the dictation targets (e.g. "chat"). Informational.
    var surface: String
    var title: String?
    var project: String?
    var agent: String?
    /// The tail of the conversation (most recent messages), oldest first.
    var conversationTail: [String]
    /// Explicit vocabulary terms to bias toward.
    var terms: [String]

    init(
        surface: String,
        title: String? = nil,
        project: String? = nil,
        agent: String? = nil,
        conversationTail: [String] = [],
        terms: [String] = []
    ) {
        self.surface = surface
        self.title = title
        self.project = project
        self.agent = agent
        self.conversationTail = conversationTail
        self.terms = terms
    }
}

extension DictationContext {
    /// Build context for the workspace chat composer from the live conversation.
    /// Takes the last few user/assistant messages as the tail (each capped so a
    /// huge message can't dominate the glossary).
    static func chat(
        title: String?,
        project: String? = nil,
        agent: String? = nil,
        entries: [NormalizedEntry],
        terms: [String] = []
    ) -> DictationContext {
        let tail = entries
            .filter { entry in
                switch entry.entryType {
                case .userMessage, .assistantMessage: return true
                default: return false
                }
            }
            .suffix(5)
            .map { $0.content.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { String($0.prefix(500)) }

        return DictationContext(
            surface: "chat",
            title: title,
            project: project,
            agent: agent,
            conversationTail: Array(tail),
            terms: terms
        )
    }

    /// Build context for dictating a new card (task) from the new-issue composer.
    static func task(title: String?, project: String?) -> DictationContext {
        DictationContext(
            surface: "task",
            title: (title?.isEmpty ?? true) ? nil : title,
            project: project
        )
    }
}
