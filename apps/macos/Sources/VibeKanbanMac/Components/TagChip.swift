import SwiftUI

struct TagChip: View {
    let tag: Tag

    var body: some View {
        HStack(spacing: 4) {
            ColorDot(hex: tag.color, size: 7)
            Text(tag.name).font(.system(size: 11))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(hex: tag.color).opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(Color(hex: tag.color).opacity(0.4), lineWidth: 0.5))
    }
}
