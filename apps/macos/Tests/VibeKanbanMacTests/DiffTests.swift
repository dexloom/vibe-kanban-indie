import XCTest

@testable import VibeKanbanMac

/// Covers the diff-stream patch applier (RFC-6902 over `{entries:{repo:{file:Diff}}}`)
/// and the unified-diff renderer.
final class DiffTests: XCTestCase {
    private func ops(_ json: String) -> [JSONValue] {
        let data = json.data(using: .utf8)!
        return try! APICoding.decoder.decode([JSONValue].self, from: data)
    }

    private func diffJSON(
        change: String, oldPath: String?, newPath: String?,
        oldContent: String?, newContent: String?, omitted: Bool = false
    ) -> String {
        func q(_ s: String?) -> String { s.map { "\"\($0.replacingOccurrences(of: "\n", with: "\\n"))\"" } ?? "null" }
        return """
        {"change":"\(change)","oldPath":\(q(oldPath)),"newPath":\(q(newPath)),\
        "oldContent":\(q(oldContent)),"newContent":\(q(newContent)),\
        "contentOmitted":\(omitted),"additions":null,"deletions":null,"repoId":null}
        """
    }

    func testReplaceRepoDiffsPopulatesSortedEntries() {
        var applier = DiffStreamApplier()
        let a = diffJSON(change: "added", oldPath: nil, newPath: "src/a.swift", oldContent: nil, newContent: "new\n")
        let b = diffJSON(change: "modified", oldPath: "src/b.swift", newPath: "src/b.swift", oldContent: "x\n", newContent: "y\n")
        applier.apply(ops: ops("""
        [{"op":"add","path":"/entries/repoA","value":{"src/b.swift":\(b),"src/a.swift":\(a)}}]
        """))
        XCTAssertEqual(applier.entries.map(\.path), ["src/a.swift", "src/b.swift"])
        XCTAssertFalse(applier.multiRepo)
    }

    func testAddThenRemoveSingleFile() {
        var applier = DiffStreamApplier()
        applier.apply(ops: ops(#"[{"op":"add","path":"/entries/repoA","value":{}}]"#))
        let d = diffJSON(change: "added", oldPath: nil, newPath: "src/new.swift", oldContent: nil, newContent: "a\n")
        applier.apply(ops: ops("""
        [{"op":"add","path":"/entries/repoA/src~1new.swift","value":\(d)}]
        """))
        XCTAssertEqual(applier.entries.map(\.path), ["src/new.swift"])

        applier.apply(ops: ops(#"[{"op":"remove","path":"/entries/repoA/src~1new.swift"}]"#))
        XCTAssertTrue(applier.entries.isEmpty)
    }

    func testMultiRepoFlagAndSort() {
        var applier = DiffStreamApplier()
        let d = diffJSON(change: "added", oldPath: nil, newPath: "f", oldContent: nil, newContent: "z\n")
        applier.apply(ops: ops("""
        [{"op":"add","path":"/entries/repoB","value":{"f":\(d)}},
         {"op":"add","path":"/entries/repoA","value":{"f":\(d)}}]
        """))
        XCTAssertTrue(applier.multiRepo)
        XCTAssertEqual(applier.entries.map(\.repoKey), ["repoA", "repoB"])
    }

    func testPointerSegmentsUnescape() {
        XCTAssertEqual(
            DiffStreamApplier.pointerSegments("/entries/repoA/src~1main.swift"),
            ["entries", "repoA", "src/main.swift"]
        )
        XCTAssertEqual(DiffStreamApplier.pointerSegments("/entries/a~0b"), ["entries", "a~b"])
    }

    func testRenderModifiedProducesUnifiedLines() {
        let diff = Diff(change: .modified, oldPath: "f", newPath: "f",
                        oldContent: "a\nb\n", newContent: "a\nc\n",
                        contentOmitted: false, additions: nil, deletions: nil, repoId: nil)
        let r = diff.render()
        XCTAssertEqual(r.additions, 1)
        XCTAssertEqual(r.deletions, 1)
        XCTAssertEqual(r.lines?.map(\.kind), [.context, .removed, .added])
        XCTAssertEqual(r.lines?.map(\.text), ["a", "b", "c"])
    }

    func testRenderAddedIsAllInsertions() {
        let diff = Diff(change: .added, oldPath: nil, newPath: "f",
                        oldContent: nil, newContent: "one\ntwo\n",
                        contentOmitted: false, additions: nil, deletions: nil, repoId: nil)
        let r = diff.render()
        XCTAssertEqual(r.additions, 2)
        XCTAssertEqual(r.deletions, 0)
        XCTAssertEqual(r.lines?.allSatisfy { $0.kind == .added }, true)
    }

    func testRenderContentOmittedReturnsStatsNote() {
        let diff = Diff(change: .modified, oldPath: "f", newPath: "f",
                        oldContent: nil, newContent: nil,
                        contentOmitted: true, additions: 3, deletions: 2, repoId: nil)
        let r = diff.render()
        XCTAssertNil(r.lines)
        XCTAssertEqual(r.additions, 3)
        XCTAssertEqual(r.deletions, 2)
        XCTAssertNotNil(r.note)
    }

    func testStripANSIRemovesColorCodes() {
        let raw = "\u{1B}[31mred\u{1B}[0m plain \u{1B}[1;32mgreen\u{1B}[0m"
        XCTAssertEqual(TerminalLogView.stripANSI(raw), "red plain green")
        XCTAssertEqual(TerminalLogView.stripANSI("no escapes"), "no escapes")
    }
}
