import SwiftUI

/// File tree placeholder (analogue of the web `FileTree`). The backend exposes
/// search (`/search`) but no tree-listing endpoint, so a full version would
/// shell the worktree at `container_ref`. (sketch)
struct FileTreeView: View {
    let workspace: Workspace?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Files").font(.fd(11, .semibold)).tracking(1.2)
                .foregroundStyle(FlightDeck.textFainter)
            if let path = workspace?.containerRef {
                HStack(spacing: 8) {
                    Image(systemName: "folder")
                        .font(.system(size: 12)).foregroundStyle(FlightDeck.textFaint)
                    Text(path)
                        .font(.fdMono(11))
                        .foregroundStyle(FlightDeck.textDim)
                        .lineLimit(2).truncationMode(.middle)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(FlightDeck.panel))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(FlightDeck.hairlineSoft))
            } else {
                Text("Worktree not available.").font(.fd(12)).foregroundStyle(FlightDeck.textFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
