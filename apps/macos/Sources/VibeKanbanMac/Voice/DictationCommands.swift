import SwiftUI

/// Action published by the focused chat composer so app-menu commands can trigger
/// voice dictation for whichever workspace window is frontmost.
struct DictateAction {
    let run: (DictationSituation) -> Void
}

private struct DictateActionKey: FocusedValueKey {
    typealias Value = DictateAction
}

extension FocusedValues {
    var dictate: DictateAction? {
        get { self[DictateActionKey.self] }
        set { self[DictateActionKey.self] = newValue }
    }
}

/// "Dictate … with Voicy" app-menu commands for the chat composer's agent-mode
/// situations (instruction / questionnaire / review). Enabled only when a chat
/// composer is focused. The `task` situation is triggered from the new-card
/// composer's own mic, not from here.
struct DictationCommands: Commands {
    @FocusedValue(\.dictate) private var dictate

    var body: some Commands {
        CommandGroup(after: .textEditing) {
            Button(DictationSituation.instruction.menuLabel) { dictate?.run(.instruction) }
                .keyboardShortcut("d", modifiers: [.option, .command])
                .disabled(dictate == nil)
            Button(DictationSituation.questionnaire.menuLabel) { dictate?.run(.questionnaire) }
                .disabled(dictate == nil)
            Button(DictationSituation.review.menuLabel) { dictate?.run(.review) }
                .disabled(dictate == nil)
        }
    }
}
