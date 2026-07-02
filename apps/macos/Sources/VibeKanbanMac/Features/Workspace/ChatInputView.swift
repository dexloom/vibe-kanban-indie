import SwiftUI

/// Follow-up composer (analogue of `SessionChatBox`).
struct ChatInputView: View {
    var onSend: (String) -> Void
    /// Conversation context for voice dictation; evaluated lazily when the mic
    /// starts. Defaults to a bare chat context so other call sites need not supply it.
    var dictationContext: () -> DictationContext = { DictationContext(surface: "chat") }
    /// Greys out Send regardless of draft content — used while a live headed
    /// agent is mid-turn (SPEC acceptance item 12: "mid-turn, Send is disabled").
    var sendDisabled: Bool = false
    @State private var text = ""
    @State private var dictation = DictationController()

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 11) {
            FDAgentChip(model: "opus")

            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text("Message the agent…")
                        .font(.fd(13.5)).foregroundStyle(FlightDeck.textFainter)
                        .padding(.vertical, 6).allowsHitTesting(false)
                }
                TextEditor(text: $text)
                    .font(.fd(13.5))
                    .foregroundStyle(FlightDeck.textSoft)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 24, maxHeight: 120)
                    .padding(.vertical, 2)
            }

            MicButton(
                controller: dictation,
                situations: DictationSituation.allCases.filter { $0.mode == .agent },
                context: dictationContext
            ) { transcript in
                appendTranscript(transcript)
            }

            Button {
                send()
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 9).fill((isEmpty || sendDisabled) ? FlightDeck.accent.opacity(0.4) : FlightDeck.accent))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(isEmpty || sendDisabled)
        }
        .padding(11)
        .background(RoundedRectangle(cornerRadius: 13).fill(FlightDeck.card))
        .overlay(RoundedRectangle(cornerRadius: 13).strokeBorder(FlightDeck.hairlineHi))
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(FlightDeck.bgTimeline)
        .onDisappear { dictation.cancel() }
        .focusedSceneValue(\.dictate, DictateAction { situation in
            dictation.request(situation: situation, context: dictationContext(), insert: appendTranscript)
        })
    }

    /// Append a dictated transcript to the current draft, inserting a separating
    /// space when needed.
    private func appendTranscript(_ transcript: String) {
        if text.isEmpty {
            text = transcript
        } else if text.hasSuffix(" ") || text.hasSuffix("\n") {
            text += transcript
        } else {
            text += " " + transcript
        }
    }

    private func send() {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        text = ""
        onSend(prompt)
    }
}
