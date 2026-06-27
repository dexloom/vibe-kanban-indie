import SwiftUI

struct PriorityBadge: View {
    let priority: IssuePriority
    var showLabel = true

    private var tint: Color {
        switch priority {
        case .urgent: return .red
        case .high: return .orange
        case .medium: return .yellow
        case .low: return .secondary
        }
    }

    var body: some View {
        if showLabel {
            Badge(text: priority.label, systemImage: priority.systemImage, tint: tint)
        } else {
            Image(systemName: priority.systemImage)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(tint)
        }
    }
}
