# ADR-017: Sidebar outliner usability — color-coding, hierarchy guides, click-to-kanban

- **Status**: Accepted
- **Date**: 2026-08-06
- **Refines**: ADR-015 (sidebar tree), ADR-007 (sidebar)
- **Relates to**: ADR-016 (orchestrator prompt node in the tree)

## Context

The sidebar outliner is the solo dev's primary navigation surface, but it
read as flat and undifferentiated: projects were all the same neutral
color, the parent/child relationship between boards and their sub-boards
was only implicit (indentation), and clicking a Tasks section or a status
did nothing useful. With multiple projects each carrying its own color,
and boards nesting arbitrarily, the tree lacked both orientation ("which
project am I in?") and hierarchy cues ("what belongs to what?").

## Decision

### 1. Color-coded projects (always on)

Every project row renders its **own** color as its label text. This is a
permanent color map, not selection-dependent:

- **Active project**: full color + `bg-tertiary` row fill + bold label.
- **Active project's subtree**: each node uses its nearest ancestor
  project's color at `0.8` alpha.
- **Everything outside the active subtree**: dimmed (`opacity-60`) with
  colors retained — the working scope stands out while the rest stays
  readable and recognizable.
- With **no project selected** (workspace/settings routes) nothing is
  dimmed; the full tree stays at full opacity. Dimming is gated on
  `activeProjectId !== null`.
- **Expandable rows are always bold** (`isExpandable || isActive`), not
  just the active one — matches how a tree reader expects parents to read.

Implemented as `nearestProjectTint()` (pure, in `treeGeometry.ts`): walk
up from any node to its nearest ancestor project, return that project's
color plus whether the node sits inside the active project's subtree.

### 2. Hierarchy guides (VSCode-style)

A per-row SVG layer draws guides at each ancestor's caret-column center
(`d * indent + caretHalf`), using `vector-effect="non-scaling-stroke"` so
lines stay crisp 1px regardless of fractional coordinates.

Column truncation rule: **an ancestor's column runs down to its LAST
DIRECT child and stops there** — it does not continue inside that child's
own children. Concretely:

- On a row whose parent is a **last child**: parent column is an **L** (└,
  vertical top→middle + horizontal tick into the caret column).
- On a **non-last child**: full-height column + tick (├/┬).
- On a **higher ancestor** (d < level-1): pure full-height vertical (I),
  but only when the row is not deeper than that ancestor's last direct
  child — otherwise the column is omitted entirely.

Implemented as `guideLines()` (pure, in `treeGeometry.ts`), using
react-arborist's `node.level` (0-based, root = 0) and `nextSibling`.

Why SVG instead of `w-px` divs: a 1px div at a fractional `left` blurs
across two device pixels (looks lighter/less sharp), and `overflow-hidden`
+ `rounded-md` clipped the top of L-lines. SVG's `non-scaling-stroke`
renders a clean pixel regardless.

Why not a single SVG behind the whole tree: it would require recomputing
geometry from the virtualized list (react-window layout API) — the exact
fragility we rejected for the earlier background-tint attempt. Per-row
SVG recomputes for free on expand/collapse and never touches the
virtualizer.

### 3. Click-to-kanban on Tasks subtree

Clicking a **Tasks section** or a **status row** now opens the project's
kanban (`onSelectProject(projectId)`) — same as clicking the project
itself. This routes through react-arborist's `onActivate` (both pointer
and keyboard). **Toggle** (expand/collapse) moved exclusively to the
caret, matching the project-row interaction from ADR-015. Cards still open
their issue in the kanban. The Workspaces section keeps its toggle-only
behavior (it has no kanban to navigate to).

### 4. Focus-ring hygiene

react-arborist focuses the `DefaultRow` (`[role=treeitem]`) on first
click; the global `*:focus { ring-inset }` drew an outline around the
just-clicked row. `rowClassName="outline-none focus:outline-none
focus:ring-0"` on the Tree kills it.

### 5. Shared row styling (DRY)

`layout.ts` exports `DIM_ROW` / `HOVER_ROW` / `TINT_ROW` class constants
and a `tintStyle(color, alpha)` helper. All eight node renderers
(project, sections, prompt, bucket, leaf, status, card) import them, so
dim/hover/transition/tint behavior stays consistent and a future renderer
can't accidentally omit it.

## Consequences

- Projects are instantly distinguishable; the active working scope reads
  at a glance even with many boards.
- Hierarchy guides make parent/child structure explicit without the
  noise of full-bleed backgrounds.
- Clicking anywhere under a project's Tasks subtree lands you in that
  project's kanban — the most common navigation gesture now "just works".
- Purely presentational changes: no wire/schema/API impact, no generated
  types changed.

### Performance

`guideLines()` is O(level²) worst case per row (nested ancestor walk);
`nearestProjectTint()` is O(level). With < 100 rows and depth ≤ 3 these
are negligible; revisit memoization only if the tree grows an order of
magnitude.

### Known deferred

- Unit tests now cover `guideLines()`/`nearestProjectTint()` (pure), but
  there is no snapshot test asserting rendered SVG output.
- Workspaces section click semantics differ from Tasks (toggle vs
  kanban) — intentional (no kanban), but a keyboard-Enter user might
  expect navigation; revisit if a workspace detail route appears.
- `COUNT_BADGE` (`ml-auto text-2xs ... opacity-70`) is still duplicated
  in three renderers; fold into `layout.ts` when next touched.
- The dimmed + drag-source cascade (`opacity-60` vs `opacity-50`) is
  resolved by class order today; make it explicit with a `!` override if
  a drag-source that is also dimmed ever looks wrong.
