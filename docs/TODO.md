# TODO — deferred work, known risks, and fragility notes

Tracking deferred items and architectural risk notes that don't belong in a
single ADR. Items are grouped by area; each links to the ADR/PR where the
context lives. Check this file before touching the sidebar outliner or the
tree geometry.

## Sidebar outliner (ADR-017)

### Deferred polish (P2, non-blocking)

- **Snapshot test for guide SVG output.** `guideLines()`/`nearestProjectTint()`
  have unit tests (`packages/ui/src/components/outliner/treeGeometry.test.ts`),
  but nothing asserts the rendered `<svg>`/`<line>` DOM. Add a snapshot once
  the guide geometry is stable.
- **Workspaces section click semantics differ from Tasks.** Tasks section +
  status rows open the kanban on click; the Workspaces section still
  toggles on row click (it has no kanban to navigate to). Intentional, but a
  keyboard-Enter user may expect navigation. Revisit if a workspace detail
  route appears.
- **`COUNT_BADGE` duplication.** `ml-auto text-2xs ... opacity-70` is
  repeated in `BucketNode.tsx`, `StatusNodeRow.tsx`, `TasksSectionNode.tsx`.
  Fold into `layout.ts` next time those files are touched.
- **Dimmed + drag-source opacity cascade.** A dragged source row that is
  also outside the active subtree renders `opacity-60` (DIM_ROW) instead of
  `opacity-50` (drag source), resolved by Tailwind class order today. Make
  it explicit with a `!` override if it ever looks wrong.

### Known fragility (documented risk, NOT a hack)

The hierarchy guides (`guideLines()`) and color coding
(`nearestProjectTint()`) depend on react-arborist's **structural** NodeApi
fields: `node.level`, `node.parent`, `node.nextSibling`. These are stable
public fields (not the layout internals that broke the earlier tint
attempt), and the pure logic is unit-tested, so an arborist upgrade that
changes their semantics turns the tests red instead of silently corrupting
pixels.

One real gap: **`nextSibling` is filtered by visibility.** Today the
sidebar has no search/filter, so this is fine. If filtering/search is ever
added to the outliner, `nextSibling` will start skipping hidden nodes and
the guides will drift. The data needed to compute guides from our own
`treeData` + open-state is already available — switch to self-computed
geometry then (no fork needed).

## Orchestrator prompts (ADR-016)

- **Cross-repo canary (open).** Add a per-tick test asserting the
  `sombra_plugins` orchestrator actually calls `get_orchestrator_prompt`
  (vs silently using built-in behavior). The `mcp_get_orchestrator_prompt_*`
  tests cover only the wire half.
- **Migration `20260806000001` is frozen** by the SHA-384 checksum guard.
  Its comment still says "first non-empty wins" (historical text);
  resolution semantics (stack) live in ADR-016. Never edit the file.

## Tree-view fork (idea — not started)

User floated forking react-arborist to render a single background div
spanning a whole node + its children (vs per-row). Evaluated: not needed.
Self-computed geometry from our `treeData` + `TREE_LAYOUT.rowHeight` +
open-state gives the same result deterministically without vendoring 300KB
of library code. Fork only becomes worth it if we also need custom DnD /
virtualization inside the tree.

## Conventions to remember

- Migrations are frozen after apply — the checksum guard bricks the server
  on macOS/Linux if edited.
- Run ONLY targeted tests on this laptop (per-crate `cargo test -p ...`,
  per-file vitest) — full suites are for CI / beefier machines.
- `packages/ui` never imports `web-core` (layer rule).
