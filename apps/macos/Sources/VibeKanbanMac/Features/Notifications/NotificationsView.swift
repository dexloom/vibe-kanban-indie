import SwiftUI

/// Notifications feed (analogue of the web `NotificationsPage`). A full version
/// would consume `/events/stream/ws` + pending approvals. (sketch)
struct NotificationsView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Notifications", systemImage: "bell").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(12)
            Divider()
            ContentUnavailableView {
                Label("No notifications", systemImage: "bell.slash")
            } description: {
                Text("Live notifications stream from /events/stream/ws and pending approvals — not wired in this sketch.")
            }
        }
        .frame(width: 460, height: 360)
    }
}
