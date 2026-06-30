import AppKit
import SwiftUI

/// "Flight Deck" design system — a dark-home theme built on one idea: agents are
/// running processes. One confident indigo accent, SF for UI, monospace for IDs
/// and code. Mirrors the claude.ai/design "Vibe Kanban — Flight Deck" concept.
///
/// Colors are literal (not semantic) so the look is identical regardless of the
/// system appearance; the app forces `.dark`.
enum FlightDeck {
    // Accent
    static let accent      = Color(hex: "6172F3")
    static let accentSoft  = Color(hex: "9AA6FF")   // accent on dark (icons)
    static let accentText  = Color(hex: "AEB6FF")   // accent text on dark

    // Status
    static let running     = Color(hex: "35C98E")
    static let runningText = Color(hex: "3AD99B")
    static let review      = Color(hex: "B07CF0")
    static let reviewText  = Color(hex: "C79CF5")
    static let failed      = Color(hex: "F0616D")
    static let failedText  = Color(hex: "F0838C")
    static let warning     = Color(hex: "E6A44A")
    static let high        = Color(hex: "E88A4A")
    static let idle        = Color(hex: "6B7080")

    // Dark neutrals — backgrounds, darkest → lightest
    static let bgDeepest   = Color(hex: "0B0C10")   // titlebar / sidebar top
    static let bgSidebar   = Color(hex: "090A0D")   // sidebar gradient bottom
    static let bgTimeline  = Color(hex: "0D0E13")   // timeline surface
    static let bg          = Color(hex: "0F1116")   // window body
    static let panel       = Color(hex: "13151C")   // grouped panel
    static let card        = Color(hex: "15171E")   // card / input
    static let raised      = Color(hex: "1D212B")
    static let segSelected = Color(hex: "262B36")   // selected segment
    static let raisedHi    = Color(hex: "2A2F3A")

    // Text
    static let text        = Color(hex: "F1F2F6")
    static let textSoft    = Color(hex: "DFE1E8")
    static let textMuted   = Color(hex: "B9BCC6")
    static let textDim     = Color(hex: "9AA0AD")
    static let textFaint   = Color(hex: "7A7F8B")
    static let textFainter = Color(hex: "5E636F")
    static let textGhost   = Color(hex: "4A4F5A")

    // Hairlines (on dark)
    static let hairline     = Color.white.opacity(0.06)
    static let hairlineSoft = Color.white.opacity(0.05)
    static let hairlineHi   = Color.white.opacity(0.09)

    // Diff
    static let diffAdd = Color(hex: "3AD99B")
    static let diffDel = Color(hex: "E06A72")

    enum Radius {
        static let window: CGFloat = 13
        static let panel: CGFloat = 11
        static let card: CGFloat = 11
        static let control: CGFloat = 9
        static let chip: CGFloat = 7
    }
}

// MARK: - Fonts

extension Font {
    /// UI / heading font (SF / system).
    static func fd(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// Mono font for IDs, branches, code, metrics. Prefers Geist Mono (the design
    /// face); falls back to the system monospaced face when it isn't installed.
    static func fdMono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        hasGeistMono
            ? Font.custom("Geist Mono", size: size).weight(weight)
            : .system(size: size, weight: weight, design: .monospaced)
    }

    private static let hasGeistMono = NSFont(name: "Geist Mono", size: 12) != nil
}

// MARK: - View styling helpers

extension View {
    /// Fill the full area with the Flight Deck window background.
    func fdWindowBackground() -> some View {
        background(FlightDeck.bg)
    }

    /// Standard card chrome: card fill, hairline border, rounded corners.
    func fdCard(radius: CGFloat = FlightDeck.Radius.card, selected: Bool = false) -> some View {
        background(RoundedRectangle(cornerRadius: radius).fill(FlightDeck.card))
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(selected ? FlightDeck.accent : FlightDeck.hairline,
                                  lineWidth: selected ? 1.5 : 1)
            )
    }
}

/// Indigo primary button (white text on accent).
struct FDPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fd(13, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: FlightDeck.Radius.control)
                .fill(FlightDeck.accent.opacity(configuration.isPressed ? 0.8 : 1)))
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == FDPrimaryButtonStyle {
    static var fdPrimary: FDPrimaryButtonStyle { FDPrimaryButtonStyle() }
}

// MARK: - Components

/// A continuously pulsing opacity, used for "live" status dots.
private struct PulseModifier: ViewModifier {
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .opacity(on ? 0.4 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                    on = true
                }
            }
    }
}

extension View {
    func fdPulse(_ active: Bool) -> some View {
        Group { if active { modifier(PulseModifier()) } else { self } }
    }
}

/// Live state of a workspace / agent, used by the dot and badge.
enum FDState {
    case running, idle, archived, error, review

    var color: Color {
        switch self {
        case .running:  return FlightDeck.running
        case .idle:     return FlightDeck.idle
        case .archived: return FlightDeck.textGhost
        case .error:    return FlightDeck.failed
        case .review:   return FlightDeck.review
        }
    }
}

/// A colored status dot. Running pulses; archived is a hollow ring.
struct FDStatusDot: View {
    let state: FDState
    var size: CGFloat = 9

    var body: some View {
        Group {
            if state == .archived {
                Circle().strokeBorder(FlightDeck.textGhost, lineWidth: 1.5)
            } else {
                Circle().fill(state.color)
                    .fdPulse(state == .running)
            }
        }
        .frame(width: size, height: size)
    }
}

/// A pill state badge (Running / Idle / Archived / Errored / Review).
struct FDStateBadge: View {
    let state: FDState

    var body: some View {
        switch state {
        case .running:  pill("Running", FlightDeck.running, FlightDeck.runningText, dot: true)
        case .idle:     pill("Idle", FlightDeck.idle, FlightDeck.textDim, dot: true)
        case .review:   pill("In review", FlightDeck.review, FlightDeck.reviewText, dot: true)
        case .error:    pill("Errored", FlightDeck.failed, FlightDeck.failedText, dot: true)
        case .archived:
            Text("Archived").font(.fd(11.5, .semibold)).foregroundStyle(FlightDeck.textFainter)
        }
    }

    private func pill(_ label: String, _ dotColor: Color, _ textColor: Color, dot: Bool) -> some View {
        HStack(spacing: 6) {
            if dot {
                Circle().fill(dotColor).frame(width: 6, height: 6).fdPulse(state == .running)
            }
            Text(label).font(.fd(11.5, .semibold))
        }
        .foregroundStyle(textColor)
        .padding(.horizontal, 10).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6).fill(dotColor.opacity(0.14)))
    }
}

/// A status tag: the backend status color as a dot + the status name.
/// `color` accepts an HSL triple or hex (via `Color(css:)`).
struct FDStatusTag: View {
    let name: String
    let color: String

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Color(css: color)).frame(width: 7, height: 7)
            Text(name).font(.fd(11, .semibold)).foregroundStyle(FlightDeck.textDim)
                .lineLimit(1)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(FlightDeck.hairline))
    }
}

/// A monospace branch chip with a git-branch glyph.
struct FDBranchChip: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(FlightDeck.textFainter)
            Text(text)
                .font(.fdMono(12))
                .foregroundStyle(FlightDeck.textDim)
                .lineLimit(1).truncationMode(.middle)
        }
        .padding(.horizontal, 9).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.035)))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(FlightDeck.hairline))
    }
}

/// An agent/model chip: a gradient diamond, the model name, and a live dot.
struct FDAgentChip: View {
    var model: String = "opus"
    var running: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Circle().fill(LinearGradient(
                    colors: [FlightDeck.accent, FlightDeck.accentSoft],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "diamond.fill")
                    .font(.system(size: 6, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 16, height: 16)
            Text(model).font(.fdMono(11, .semibold)).foregroundStyle(FlightDeck.accentText)
            if running {
                Circle().fill(FlightDeck.running).frame(width: 5, height: 5).fdPulse(true)
            }
        }
        .padding(.leading, 4).padding(.trailing, 8).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: FlightDeck.Radius.chip).fill(FlightDeck.accent.opacity(0.14)))
        .overlay(RoundedRectangle(cornerRadius: FlightDeck.Radius.chip).strokeBorder(FlightDeck.accent.opacity(0.28)))
    }
}

/// A `+adds −dels` diff stat in monospace.
struct FDDiffStat: View {
    let add: Int?
    let del: Int?

    var body: some View {
        HStack(spacing: 9) {
            if let add, add > 0 {
                Text("+\(add)").font(.fdMono(12, .medium)).foregroundStyle(FlightDeck.diffAdd)
            }
            if let del, del > 0 {
                Text("−\(del)").font(.fdMono(12, .medium)).foregroundStyle(FlightDeck.diffDel)
            }
        }
    }
}
