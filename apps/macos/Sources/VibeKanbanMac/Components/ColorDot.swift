import SwiftUI

/// Small colored status/label dot (native analogue of the web color dot).
/// `hex` accepts any backend color string (HSL triple or hex) via `Color(css:)`.
struct ColorDot: View {
    let hex: String
    var size: CGFloat = 9

    var body: some View {
        Circle()
            .fill(Color(css: hex))
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(.white.opacity(0.15), lineWidth: 0.5))
    }
}
