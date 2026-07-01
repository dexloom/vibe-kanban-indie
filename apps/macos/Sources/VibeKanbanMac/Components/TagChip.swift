import SwiftUI

struct TagChip: View {
    let tag: Tag

    private var color: Color { Color(css: tag.color) }

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(tag.name).font(.fd(11)).foregroundStyle(FlightDeck.textMuted)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(color.opacity(0.16), in: Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.4), lineWidth: 0.5))
    }
}
