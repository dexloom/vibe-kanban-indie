import SwiftUI

/// Renders markdown via `AttributedString` (a lightweight stand-in for the
/// web's Lexical renderer). Falls back to plain text when parsing fails.
struct MarkdownText: View {
    let text: String

    var body: some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed).textSelection(.enabled)
        } else {
            Text(text).textSelection(.enabled)
        }
    }
}
