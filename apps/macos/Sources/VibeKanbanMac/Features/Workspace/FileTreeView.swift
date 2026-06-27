import SwiftUI

/// File tree placeholder (analogue of the web `FileTree`). The backend exposes
/// search (`/search`) but no tree-listing endpoint, so a full version would
/// shell the worktree at `container_ref`. (sketch)
struct FileTreeView: View {
    let workspace: Workspace?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Files", systemImage: "folder").font(.subheadline.weight(.semibold))
            if let path = workspace?.containerRef {
                Text(path)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2).truncationMode(.middle)
            } else {
                Text("Worktree not available.").font(.caption).foregroundStyle(.tertiary)
            }
            Text("File tree not wired in this sketch.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
