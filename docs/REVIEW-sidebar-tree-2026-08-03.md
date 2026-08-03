# Sidebar Project Tree — Code Review (Consensus Synthesis)

- **Date**: 2026-08-03
- **Branch**: `feat/ui-modernization`
- **Scope** (files reviewed):
  - `packages/ui/src/components/SidebarProjectTree.tsx`
  - `packages/ui/src/components/outliner/{types,LeafNode,BucketNode,useContainerHeight}.ts(x)`
  - `packages/web-core/src/shared/hooks/useWorkspaceProjectMembership.ts`
  - `packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx`
  - `docs/ADR/ADR-007-sidebar-project-workspaces-tree.md`
- **Method**: Two independent architectural + code-quality reviews (A: 6.5, B: 6.3), reconciled by re-reading current source. All MUST-FIX claims verified against `SidebarProjectTree.tsx` + `LeafNode.tsx` as of this commit.

---

## 1. Executive Summary

The sidebar tree is a sound react-arborist implementation: clean discriminated-union node model, a correct persistence seam (seed-once verified against the arborist store), a well-engineered ResizeObserver hook, and M:N membership derivation that matches ADR-007. The scaffolding is genuinely good. But it ships **one real user-facing bug** — workspace leaves never highlight as active because the tree threads `activeProjectId` through `selection`, which cannot match a leaf's workspace id — plus a cluster of quality issues concentrated in three spots: the `as unknown as` casts in `TreeNodeRouter`, an inline-style `paddingLeft` override in `LeafNode` that fights arborist's geometry, and a duplicated 14-field mapper in `SharedAppLayout`. ADR-007 also drifted from code on the indent value (8px in text, 12px in code) — the 12px is the owner-approved visual, so the ADR should be amended, not the code reverted. None of the issues are architectural emergencies; most are one-sweep refactors. **Consensus score: 6.4 / 10**, with a clear path to 9.

---

## 2. MUST-FIX

| ID | File:line | Problem | Clean Fix |
|----|-----------|---------|-----------|
| **M1** | `SidebarProjectTree.tsx:79,587` (props + `selection`) | **Active-workspace highlight never fires.** Tree passes only `activeProjectId` to `selection={activeProjectId}`. react-arborist sets `node.isSelected` when a node's `id === selection`. Leaf node ids are workspace ids, never a project id → leaves are never selected → `LeafNode.tsx:18` `isActive = node.isSelected` is permanently false. Verified: no `activeWorkspaceId` prop exists on the component. User-visible regression: the tree never shows which workspace you're on. | Accept a new `activeWorkspaceId: string \| null` prop; in `LeafNode`, compute highlight from `ws.id === activeWorkspaceId` (not `node.isSelected`); keep `selection={activeProjectId}` for project rows, or drop `selection` entirely and compute both highlights explicitly. Thread `activeWorkspaceId` from `SharedAppLayout` via `useWorkspaceContext().workspaceId`. |
| **M2** | `SidebarProjectTree.tsx:325,327,329` (`TreeNodeRouter`) | **Three `as unknown as` casts** defeat the discriminated union at the one place it should pay off. The `project` branch already shows the right pattern (line 323: a precise inline cast); the other three branches erase types wholesale. | Narrow each cast to the branch's concrete type, mirroring line 323. Better: give `TreeNodeRouter` a typed dispatch that re-derives `node.data` from `data.type` so each renderer gets `NodeRendererProps<ConcreteNode>` without any cast. |
| **M3** | `SidebarProjectTree.tsx:577` vs `ADR-007:27` | **ADR/code indent drift.** ADR-007 says "indent reduced to 8px"; code uses `indent={12}`. The 12px is a deliberate owner-approved visual choice (3 levels at 256px read better), so the code is right and the doc is stale. | **Amend ADR-007** (add a dated `Amendment` note): change "indent 8" → "indent 12 (revised 2026-08-03, owner-approved visual)". Do **not** revert code to 8. |
| **M4** | `SharedAppLayout.tsx:233-275` | **Duplicated 14-field `OutlinerWorkspace` mapper.** `outlinerWorkspaces` and `outlinerArchivedWorkspaces` are byte-for-byte identical maps over `activeWorkspaces` / `archivedWorkspaces`. Adding a field means editing two places. | Extract `function toOutlinerWorkspace(ws: LocalWorkspaceShape): OutlinerWorkspace` (or a shared mapper exported from `outliner/types.ts` next to the interface). Both `useMemo` blocks shrink to `.map(toOutlinerWorkspace)`. |
| **M5** | `LeafNode.tsx:40-44` | **`LEAF_CONTENT_OFFSET` mutates arborist's `style.paddingLeft` in place.** The guide geometry at lines 30-34 depends on arborist's original `paddingLeft`; the override is correct *today* only because the guide is computed before the mutation. Fragile — the next refactor that reorders these lines silently breaks the dotted guide. | **Child-wrapper fix:** keep arborist's `style` untouched on the outer div (so geometry stays authoritative), and offset content via a Tailwind `pl-[10px]` on an inner `<div className="relative pl-[10px]">` wrapper. Outer div owns the guide spans; inner wrapper owns content offset. |
| **M6** | `SharedAppLayout.tsx:198-215` (`handleCreateProject`) | **Void-suppressed dead code.** `handleCreateProject` is defined, then `void handleCreateProject;` (line 215) silences the unused-var lint. It's a no-op stub with no caller; the comment even admits it. | **Delete** both the `handleCreateProject` callback (198-209) and the `void handleCreateProject;` line (215). Re-derive the wiring when the future context-menu surface actually lands — git remembers the shape. |
| **M7** | `SidebarProjectTree.tsx:268` | **Hardcoded aria-label.** `aria-label="Open project kanban"` is the only untranslated string in a file where every other label goes through `t()`. | `aria-label={t('sidebar.openProjectKanban')}` (add the key to `common.json`). |

---

## 3. SHOULD-FIX

| ID | File:line | Problem | Clean Fix |
|----|-----------|---------|-----------|
| **S1** | `SidebarProjectTree.tsx:46` vs `useWorkspaceProjectMembership.ts:22` | **Membership type duplication.** `SidebarMembership = Map<string, Set<string>>` (ui pkg) is structurally identical to `WorkspaceProjectMembership` (web-core pkg). Two names, one shape, across the package boundary. | Export `WorkspaceProjectMembership` from a shared types module (or from `outliner/types.ts`) and import it in both packages; delete `SidebarMembership`. Structural typing already makes this safe — collapse the alias. |
| **S2** | `outliner/types.ts:24-89` | **Legacy naming + dual persistence scheme.** `PERSIST_KEYS`, `BucketId`, `readInitialOpenState` belong to the old per-bucket `WorkspaceOutliner` (ADR-006). They survive only as a first-run migration inside `buildSidebarTreeInitialOpenState` (line 150). Names imply active use; readers get confused. | Either (a) inline the one-time legacy read and drop the exported symbols, or (b) rename to `LEGACY_BUCKET_PERSIST_KEYS` + `readLegacyBucketOpenState` to mark them as migration-only. |
| **S3** | `SidebarProjectTree.tsx:285-312` + `BucketNode.tsx` | **Section and Bucket caret markup duplicated.** `SectionTreeNode` and `OutlinerBucketNode` render the same `CaretRightIcon` + rotate + label + `ml-auto` count pattern. | Extract a `<TreeCaretRow label count open />` primitive into `outliner/`; both nodes compose it. Reduces the two files to thin wrappers. |
| **S4** | `SidebarProjectTree.tsx:179-211` (`buildTreeData`) | **Section not extensible.** ADR-007 names future per-project sections (TODOs, Notes). Today `buildTreeData` hardcodes a single `"Workspaces"` `SectionNode` per project; adding a section means editing the builder + the open-state resolver. | Introduce a `makeWorkspacesSection(projectId, buckets)` (and later `makeTodosSection`, etc.); have `buildTreeData` concatenate section builders per project. Open-state resolution already keys by node id, so new sections are free. |
| **S5** | `outliner/types.ts:103-132` | **Persistence blob has no GC and no schema version.** `readSidebarTreeOpenState` returns the raw JSON blob as-is. Deleted projects' node ids accumulate forever; a future format change silently corrupts reads. Key is `vibe.ui.sidebarTree.openState`. | (a) On read, drop keys whose projectId prefix isn't in the live project set (GC on read — caller passes `projectIds`). (b) Wrap the blob as `{ v: 1, state: {...} }`; on parse, migrate or reset by version. **Do not over-engineer** — single blob + version + read-time GC is enough; no per-project keys, no IndexedDB. |
| **S6** | `SidebarProjectTree.tsx:587` | **`selection` prop becomes redundant after M1.** Once leaves highlight from `activeWorkspaceId`, the arborist `selection` prop only serves project rows and its meaning ("selected id") is ambiguous across node types. | After M1 lands, drop the `selection` prop; compute project-active styling explicitly in `ProjectTreeNode` (it already takes `activeProjectId`). One less implicit arborist coupling. |
| **S7** | `SidebarProjectTree.tsx:426-433` + `outliner/types.ts:98-101` | **Persistence correctness depends on undocumented arborist internals.** The seed-once behavior (initialOpenState consumed only at mount) is real and verified, but it's enforced by a comment citing `provider.js: createStore inside useRef`. An unpinned arborist upgrade could break it silently. | Pin `react-arborist` to an exact version in `package.json`; add a Vitest that mounts `<Tree initialOpenState={...}>`, toggles a node, re-renders with a new `initialOpenState`, and asserts the tree's open state is unchanged (regression guard for the seed-once contract). |
| **S8** | `SidebarProjectTree.tsx:314-331` (`TreeNodeRouter`) | **Narrow-cast refactor is the proper home for M2.** The cast cluster exists because the router fans out a `NodeRendererProps<SidebarTreeNode>` union to four concrete renderers. | Replace per-branch casts with a single typed narrowing: build `props` once as `NodeRendererProps<typeof data>` inside each `case` (TS narrows `data` from the switch), then spread. Eliminates all three `as unknown as` in one move. |

---

## 4. NICE-TO-HAVE

| ID | File:line | Problem | Clean Fix |
|----|-----------|---------|-----------|
| **N1** | `SidebarProjectTree.tsx` (609 lines) | Single file holds props, 4 node renderers, tree builder, drag handlers, persistence wiring. Large by the project's own "small files in a hierarchy" preference. | Split: `outliner/{ProjectNode,SectionNode}.tsx`; keep the root `SidebarProjectTree.tsx` as orchestrator + drag handlers. Bucket/Leaf already live in `outliner/`. |
| **N2** | `SidebarProjectTree.tsx:343,577,578-582,584` | **Layout magic numbers.** `width=256`, `indent={12}`, row heights `40/32/24`, `padding={2}` are scattered as literals. | Hoist into an `outliner/layout.ts` constants module (`SIDEBAR_WIDTH`, `TREE_INDENT`, `ROW_HEIGHTS`, `TREE_PADDING`). Makes the ADR-007 indent amendable in one place. |
| **N3** | `SidebarProjectTree.tsx:181,200` | **`makeWorkspacesSectionId` factory missing.** The template literal `\`${project.id}:workspaces\`` is spelled out twice (plus the type `${string}:workspaces` at line 33). | `const makeWorkspacesSectionId = (pid: string): WorkspacesSectionId => \`${pid}:workspaces\`;` — one source of truth for the section-id grammar. |
| **N4** | `SidebarProjectTree.tsx:119-126` | **`buildTreeData` takes 6 positional args**, 4 of which are derived maps the caller already computed together. | Accept a single `options` object: `{ projects, workspacesByProject, archivedWorkspacesByProject, unassignedActive, unassignedArchived, t }`. Improves readability + call-site naming. |
| **N5** | `outliner/types.ts:78,108,125` (`window.localStorage`) | **SSR guard absent.** `window.localStorage` is accessed without a `typeof window` check. SSR is currently disabled in this fork, so it's latent — but the surrounding comments claim "safe to call during render". | Wrap the three access points in `typeof window !== 'undefined'` (the `try/catch` already swallows errors; this closes the "window is undefined" case the comment implies is handled). |
| **N6** | `SidebarProjectTree.tsx:447-451` (`queueMicrotask` write) | **Post-unmount write note.** If the component unmounts between `queueMicrotask` scheduling and flush, the microtask still calls `writeSidebarTreeOpenState`. Harmless (it writes a ref's last value; storage write is idempotent + try/caught), but technically a write after unmount. | Either accept it (document as benign) or capture a `mounted` flag and skip the write on flush. Low priority — current behavior is correct, just worth a one-line comment. |
| **N7** | `SidebarProjectTree.tsx:103-112` (`getProjectInitials`) | **Possible dup.** A `getProjectInitials`-like helper likely already exists for project avatars elsewhere in the app. | Grep before keeping; if a shared `getInitials(name)` exists in `@vibe/ui`, reuse it. If not, leave as-is. |
| **N8** | `SidebarProjectTree.tsx:504-521` (`handleMove`) | **Unassigned-math is subtle.** `visibleProjects` includes `UNASSIGNED_PROJECT_ID`; the `reordered.filter(id => id !== UNASSIGNED)` at line 519 strips it *after* index math. Correct today, but the filter-then-strip ordering is easy to break. | Filter unassigned out of `visibleProjects` *before* the splice math, then append it back at the end if present. Makes the invariant "Unassigned is always last" explicit in code, not just behavior. |

---

## 5. What's Already Good (Don't Touch)

- **`useContainerHeight` callback-ref RO hook** (`outliner/useContainerHeight.ts`): textbook callback-ref backed by state so the observer (re)attaches when the measured div mounts late (loading/empty branch flip). A plain ref + empty-deps effect would have measured once at height 0 and never recovered. Excellent.
- **Discriminated-union node model** (`SidebarTreeNode = ProjectNode | SectionNode | BucketNode | LeafNode`): the `type` tag drives `TreeNodeRouter`, `rowHeight`, `disableDrag/Drop`, and `handleActivate` cleanly. This is the right shape; the casts in M2 are a *failure to exploit it*, not a flaw in the model.
- **Persistence seam correctness**: verified — `initialOpenState` is memoized from `projectIds` (line 430-433), arborist consumes it exactly once at mount, and the in-memory `openStateRef` mirrors toggles for side-effect persistence only. The seed-once contract is real, not assumed.
- **Pure domain module** (`outliner/types.ts`): the open-state read/write/build functions are framework-free and unit-testable in isolation.
- **Structural typing across the package boundary**: `OutlinerWorkspace extends WorkspaceStatusItem` — the ui package consumes a trimmed shape without importing the full local workspace type. Clean seam.
- **`queueMicrotask` coalescing** (line 444-451): bursts of synchronous toggles collapse into one localStorage write. Idiomatic and cheap.
- **Guard clauses in `handleMove`** (lines 496-502): `parentId !== ROOT`, empty dragNodes, non-project drag, and Unassigned drag are each rejected early and explicitly. The reorder math is the only thing left after the guards — easy to reason about.
- **Optimistic reorder with rollback** (`SharedAppLayout.handleProjectsReorder`, lines 150-190): `setOrderedProjects` → persist → `setOrderedProjects(previousOrder)` on catch. Correct, mirrors the prior dnd flow.

---

## 6. Consensus Score & "To Reach 9" Checklist

**Consensus score: 6.4 / 10** (reconciles review A's 6.5 and review B's 6.3).

The half-point gap between the two reviews came from differing weight on the active-workspace bug (A treated it as the dominant finding; B weighted the cast cluster + duplication higher). Both are right: M1 is the only *user-visible* defect, but M2/M4/M5 are the ones that will rot fastest. Reconciling at 6.4 acknowledges a solid foundation dragged down by one real bug and a tight cluster of quality smells.

### To reach 9

- [ ] **M1** — wire `activeWorkspaceId`; leaves highlight the live workspace.
- [ ] **M2 / S8** — eliminate all three `as unknown as` casts via typed dispatch in `TreeNodeRouter`.
- [ ] **M3** — amend ADR-007 indent 8 → 12 (doc-only).
- [ ] **M4** — extract the shared `toOutlinerWorkspace` mapper.
- [ ] **M5** — move the leaf content offset to an inner Tailwind wrapper; stop mutating arborist's `style.paddingLeft`.
- [ ] **M6** — delete `handleCreateProject` + its `void` suppression.
- [ ] **M7** — i18n the hardcoded aria-label.
- [ ] **S5** — add read-time GC + schema version to the persistence blob.
- [ ] **S7** — pin `react-arborist` exact + add the seed-once regression test.

After the above, the remaining SHOULD/NICE items are ordinary hygiene; they don't block the score.

---

## 7. Suggested Follow-Up

**Implement in two sweeps, not one.** The MUST-FIX table is cohesive and low-risk; do it as a single PR. The SHOULD-FIX items (especially S5 persistence versioning and S7 the arborist pin + test) deserve their own PRs because each touches a different concern (persistence schema, dependency pinning, type system) and benefits from isolated review.

**Sweep 1 — MUST-FIX (one PR, ~half-day):** M1, M2(+S8), M4, M5, M6, M7. All are local refactors with no cross-module contract changes except M1 (which adds one prop threaded through `SharedAppLayout`). Add a Vitest for M1 that asserts a leaf renders `aria-current="page"` when its workspace id matches `activeWorkspaceId`.

**Sweep 2 — ADR + persistence (doc + small PR):** M3 (amend ADR-007, doc-only) and S5 (persistence GC + version) ship together — both are about getting the persistence + spec story straight. S7 (pin arborist + seed-once test) can ride along or split.

**Sweep 3 — hygiene (optional, batched):** S1–S4, S6, all NICE-TO-HAVE. No deadline; pick up when touching neighboring code.

**New ADR amendment needed:** yes — **M3**. ADR-007's "indent 8" line is the only stale spec; amend it to record the owner-approved 12px decision with a dated note. No new ADR required for the `activeWorkspaceId` addition (it's a bug fix against the existing ADR-007 intent, which already implies per-workspace nav highlighting).
