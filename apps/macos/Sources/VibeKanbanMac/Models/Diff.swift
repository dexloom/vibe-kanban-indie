import Foundation

/// One changed file in a workspace diff. Mirrors `crates/utils/src/diff.rs`
/// `Diff` (serde `camelCase`), streamed over `/workspaces/{id}/git/diff/ws`.
struct Diff: Codable, Hashable {
    let change: DiffChangeKind
    let oldPath: String?
    let newPath: String?
    let oldContent: String?
    let newContent: String?
    /// True when file contents are intentionally omitted (binary / too large).
    let contentOmitted: Bool
    /// Precomputed stats, only set when `contentOmitted`.
    let additions: Int?
    let deletions: Int?
    let repoId: String?

    /// The path to show (new path for adds/mods, old for deletes/renames source).
    var displayPath: String { newPath ?? oldPath ?? "(unknown)" }
}

enum DiffChangeKind: String, Codable, Hashable {
    case added, deleted, modified, renamed, copied, permissionChange
}

/// One file in the flattened diff list (repo namespace + path + diff).
struct DiffEntry: Identifiable, Hashable {
    let repoKey: String
    let path: String
    let diff: Diff
    var id: String { "\(repoKey)\u{0}\(path)" }
}

/// Applies the diff stream's RFC-6902 patches to a
/// `{ entries: { <repoKey>: { <filePath>: Diff } } }` document and exposes a
/// flat, sorted file list. Mirrors `ConversationPatch` diff helpers
/// (`/entries/<repo>` replace; `/entries/<repo>/<file>` add/remove).
struct DiffStreamApplier {
    /// repoKey -> (filePath -> Diff)
    private(set) var repos: [String: [String: Diff]] = [:]

    /// Whether more than one repo contributes changes (drives path prefixing).
    var multiRepo: Bool { repos.count > 1 }

    var entries: [DiffEntry] {
        repos
            .flatMap { repoKey, files in
                files.map { DiffEntry(repoKey: repoKey, path: $0.key, diff: $0.value) }
            }
            .sorted {
                if $0.repoKey != $1.repoKey { return $0.repoKey < $1.repoKey }
                return $0.path.localizedStandardCompare($1.path) == .orderedAscending
            }
    }

    mutating func reset() { repos.removeAll() }

    mutating func apply(ops: [JSONValue]) {
        for op in ops {
            guard case let .object(fields) = op,
                  case let .string(opName)? = fields["op"],
                  case let .string(path)? = fields["path"]
            else { continue }

            let segs = Self.pointerSegments(path)
            guard segs.first == "entries" else { continue }
            let parts = Array(segs.dropFirst())   // [repo] or [repo, file]

            switch opName {
            case "remove":
                if parts.count == 1 {
                    repos[parts[0]] = nil
                } else if parts.count == 2 {
                    repos[parts[0]]?[parts[1]] = nil
                }
            case "add", "replace":
                guard let value = fields["value"] else { continue }
                if parts.count == 1 {
                    repos[parts[0]] = Self.decode([String: Diff].self, value) ?? [:]
                } else if parts.count == 2 {
                    if let diff = Self.decode(Diff.self, value) {
                        repos[parts[0], default: [:]][parts[1]] = diff
                    }
                }
            default:
                break
            }
        }
    }

    /// Split a JSON Pointer into its unescaped segments (`~1`→`/`, `~0`→`~`).
    static func pointerSegments(_ path: String) -> [String] {
        path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map {
                $0.replacingOccurrences(of: "~1", with: "/")
                    .replacingOccurrences(of: "~0", with: "~")
            }
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> T? {
        guard let data = try? APICoding.encoder.encode(value) else { return nil }
        return try? APICoding.decoder.decode(T.self, from: data)
    }
}

// MARK: - Unified-diff rendering

/// A single rendered line of a unified diff.
struct DiffHunkLine: Hashable {
    enum Kind { case context, added, removed }
    let kind: Kind
    let text: String
}

/// The render result for one file: either rendered lines, or a collapsed
/// summary (omitted / very large), plus +/- counts.
struct RenderedDiff {
    let lines: [DiffHunkLine]?
    let additions: Int
    let deletions: Int
    let note: String?
}

extension Diff {
    /// Compute a unified, line-level diff from `oldContent`/`newContent`. Returns
    /// a collapsed summary (no lines) when content is omitted or the file is too
    /// large to diff cheaply.
    func render(maxLines: Int = 4000) -> RenderedDiff {
        if contentOmitted {
            return RenderedDiff(
                lines: nil,
                additions: additions ?? 0,
                deletions: deletions ?? 0,
                note: "Content omitted (binary or too large)."
            )
        }

        let oldLines = Self.split(oldContent)
        let newLines = Self.split(newContent)

        if oldLines.count + newLines.count > maxLines {
            return RenderedDiff(
                lines: nil,
                additions: additions ?? 0,
                deletions: deletions ?? 0,
                note: "Large file collapsed — \(oldLines.count) → \(newLines.count) lines."
            )
        }

        let lines = Self.unify(oldLines, newLines)
        let adds = lines.reduce(0) { $0 + ($1.kind == .added ? 1 : 0) }
        let dels = lines.reduce(0) { $0 + ($1.kind == .removed ? 1 : 0) }
        return RenderedDiff(lines: lines, additions: adds, deletions: dels, note: nil)
    }

    /// Split into lines, dropping the single trailing empty produced by a final
    /// newline (so a file isn't reported as having a phantom blank last line).
    static func split(_ s: String?) -> [String] {
        guard let s, !s.isEmpty else { return [] }
        var lines = s.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }
        return lines
    }

    /// Merge two line arrays into an ordered unified diff using
    /// `CollectionDifference`. Removals (`-`) precede insertions (`+`) at the
    /// same position; unchanged lines are context.
    static func unify(_ oldLines: [String], _ newLines: [String]) -> [DiffHunkLine] {
        let difference = newLines.difference(from: oldLines)
        var removalAt: [Int: String] = [:]   // offset into old
        var insertionAt: [Int: String] = [:] // offset into new
        for change in difference {
            switch change {
            case let .remove(offset, element, _): removalAt[offset] = element
            case let .insert(offset, element, _): insertionAt[offset] = element
            }
        }

        var out: [DiffHunkLine] = []
        var oi = 0, ni = 0
        while oi < oldLines.count || ni < newLines.count {
            if let removed = removalAt[oi] {
                out.append(DiffHunkLine(kind: .removed, text: removed))
                oi += 1
            } else if let added = insertionAt[ni] {
                out.append(DiffHunkLine(kind: .added, text: added))
                ni += 1
            } else if oi < oldLines.count {
                out.append(DiffHunkLine(kind: .context, text: oldLines[oi]))
                oi += 1
                ni += 1
            } else {
                ni += 1   // safety net; shouldn't be reached
            }
        }
        return out
    }
}
