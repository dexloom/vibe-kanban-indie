import SwiftUI

/// Overlapping initials avatars for issue assignees.
struct AvatarStack: View {
    let names: [String]
    var limit = 3

    var body: some View {
        HStack(spacing: -6) {
            ForEach(Array(names.prefix(limit).enumerated()), id: \.offset) { _, name in
                Avatar(initials: initials(name))
            }
            if names.count > limit {
                Avatar(initials: "+\(names.count - limit)")
            }
        }
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ")
        return String(parts.prefix(2).compactMap(\.first)).uppercased()
    }
}

private struct Avatar: View {
    let initials: String
    var body: some View {
        Text(initials)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 20, height: 20)
            .background(Circle().fill(Color.accentColor))
            .overlay(Circle().strokeBorder(Color(nsColor: .windowBackgroundColor), lineWidth: 1.5))
    }
}
