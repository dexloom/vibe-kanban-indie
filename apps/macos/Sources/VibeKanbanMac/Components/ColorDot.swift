import SwiftUI

/// Small colored status/label dot (native analogue of the web color dot).
struct ColorDot: View {
    let hex: String
    var size: CGFloat = 9

    var body: some View {
        Circle()
            .fill(Color(hex: hex))
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5))
    }
}
