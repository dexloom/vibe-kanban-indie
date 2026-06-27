import Foundation
import Observation

/// Drives one external dictation request against Voicy and exposes UI state. The
/// mic opens Voicy (in the chosen mode); the user dictates/refines there and
/// clicks "Send to vibe-kanban"; the prepared text is inserted via `insert`.
/// Owned per input surface as `@State`.
@MainActor
@Observable
final class DictationController {
    enum State: Equatable {
        case idle
        case waiting          // Voicy is open; waiting for the user's Send
        case error(String)
    }

    private(set) var state: State = .idle

    private let client: VoicyClient
    private var task: Task<Void, Never>?

    init(client: VoicyClient = VoicyClient()) {
        self.client = client
    }

    var isWaiting: Bool { state == .waiting }

    /// Open Voicy for a dictation in `situation` and insert the prepared text when
    /// the user sends it back. The situation picks the Voicy surface and (via
    /// `VoiceAgentMap`) the Voicy agent. No-op if a request is already in flight.
    func request(situation: DictationSituation,
                 context: @autoclosure () -> DictationContext,
                 insert: @escaping (String) -> Void) {
        guard state != .waiting else { return }
        let ctx = context()
        let mode = situation.mode
        let agentId = mode == .agent ? VoiceAgentMap.agentId(for: situation) : nil
        state = .waiting
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let text = try await self.client.requestDictation(mode: mode, agentId: agentId, context: ctx)
                self.state = .idle
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { insert(trimmed) }
            } catch is CancellationError {
                self.state = .idle
            } catch VoiceError.cancelled {
                self.state = .idle
            } catch {
                self.state = .error(error.localizedDescription)
            }
            self.task = nil
        }
    }

    /// Cancel an in-flight request (also tells Voicy to drop the session).
    func cancel() {
        task?.cancel()
        task = nil
        state = .idle
    }
}
