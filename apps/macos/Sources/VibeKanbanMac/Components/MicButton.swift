import SwiftUI

/// Mic control bound to a `DictationController`. Idle: if it offers one situation
/// it's a direct button; with several it's a menu. Picking one opens Voicy. While
/// waiting for the user's "Send to vibe-kanban", it shows a spinner that cancels
/// on click.
struct MicButton: View {
    var controller: DictationController
    /// The dictation situations this mic offers (e.g. the agent situations in the
    /// chat composer, or just `.task` on the new-card composer).
    var situations: [DictationSituation]
    /// Built lazily — only evaluated when a dictation actually starts.
    var context: () -> DictationContext
    /// Receives the prepared text when Voicy sends it back.
    var onText: (String) -> Void

    /// Square edge — kept equal to the composer's Send button.
    private let dim: CGFloat = 34

    var body: some View {
        Group {
            if controller.isWaiting {
                Button(action: controller.cancel) {
                    ProgressView().controlSize(.small).frame(width: dim, height: dim).background(chrome)
                }
                .buttonStyle(.plain)
                .help("Waiting for Voicy — click to cancel")
            } else if situations.count == 1, let only = situations.first {
                Button { start(only) } label: { iconLabel }
                    .buttonStyle(.plain)
                    .help(helpText)
            } else {
                Menu {
                    ForEach(situations) { situation in
                        Button(situation.title) { start(situation) }
                    }
                } label: { iconLabel }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(helpText)
            }
        }
    }

    private var iconLabel: some View {
        Image(systemName: icon)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: dim, height: dim)
            .background(chrome)
    }

    private var chrome: some View {
        RoundedRectangle(cornerRadius: 9)
            .fill(FlightDeck.card)
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(FlightDeck.hairlineHi))
    }

    /// Start a dictation for `situation`.
    func start(_ situation: DictationSituation) {
        controller.request(situation: situation, context: context(), insert: onText)
    }

    private var icon: String {
        if case .error = controller.state { return "mic.slash" }
        return "mic"
    }

    private var tint: Color {
        if case .error = controller.state { return FlightDeck.warning }
        return FlightDeck.accentSoft
    }

    private var helpText: String {
        if case .error(let message) = controller.state { return message }
        return "Dictate with Voicy"
    }
}
