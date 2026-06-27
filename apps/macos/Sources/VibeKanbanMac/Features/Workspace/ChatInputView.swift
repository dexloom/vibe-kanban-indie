import SwiftUI

/// Follow-up composer (analogue of `SessionChatBox`).
struct ChatInputView: View {
    var onSend: (String) -> Void
    @State private var text = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 36, maxHeight: 120)
                .padding(6)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
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
    }

    private func send() {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        text = ""
        onSend(prompt)
    }
}
