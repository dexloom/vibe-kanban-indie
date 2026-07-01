import SwiftUI

/// Export view (analogue of the web `ExportPage`). Pick projects, then export.
/// The backend `/export` returns the static config (TOML); per-project export is
/// a sketch placeholder. (sketch)
struct ExportView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Export", systemImage: "square.and.arrow.up").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
            }
            .padding(12)
            Divider()
            List(app.projects, selection: $selected) { project in
                Label { Text(project.name) } icon: { ColorDot(hex: project.color) }
                    .tag(project.id)
            }
            Divider()
            HStack {
                Text("\(selected.count) selected").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Export…") { /* TODO sketch: GET /export → .fileExporter */ }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty)
            }
            .padding(12)
        }
        .frame(width: 460, height: 400)
    }
}
