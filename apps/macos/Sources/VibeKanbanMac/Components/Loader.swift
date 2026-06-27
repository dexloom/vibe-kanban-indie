import SwiftUI

/// Centered progress spinner with an optional caption.
struct Loader: View {
    var caption: String?

    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
            if let caption {
                Text(caption).font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
