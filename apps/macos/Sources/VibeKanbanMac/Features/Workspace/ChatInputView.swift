import SwiftUI

/// Follow-up composer (analogue of `SessionChatBox`).
struct ChatInputView: View {
    var onSend: (String) -> Void
    /// Conversation context for voice dictation; evaluated lazily when the mic
    /// starts. Defaults to a bare chat context so other call sites need not supply it.
    var dictationContext: () -> DictationContext = { DictationContext(surface: "chat") }
    @State private var text = ""
    @State private var dictation = DictationController()

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 36, maxHeight: 120)
                .padding(6)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
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
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(10)
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
