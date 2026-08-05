# Nodal engine — exploration notes (2026-08-05)

**Status**: Rejected (full rewrite). `nodes` super-index = high priority, separate TODO.

## The proposal (considered, rejected as full rewrite)

Make the entire engine nodal — "everything is a node": project, board,
kanban board, status column, issue, sub-issue, comment, tag, workspace all
live in one connected graph starting from a root. Uniform traversal, uniform
DnD, infinite nesting, one breadcrumb, one tree builder.

Key constraint offered: **no backward compatibility required** — dev data is
small/disposable, so the sqlx table-recreation data-loss trap (ADR-013) was
moot. This changed the migration-safety calculus but NOT the core objection.

## Consultation

- Two independent critical reviews of ADR-013 (review-glm 8.5, review-deepseek
  8.0) — both scored the current relational implementation, both confirmed the
  migration is safe.
- Architecture escalation (`@escalate-glm`): **verdict NO full nodal,
  confidence 8/10.** "Stay relational, increment."

## Why full nodal loses (escalate-glm, verified)

1. **The system is already ~80% nodal.** `projects.parent_id` (ADR-013),
   `issues.parent_issue_id` + `parent_issue_sort_order`, threaded
   `issue_comments.parent_id`, `issue_relationships` edge table, `issue_workspaces`
   M:N, a uniform `DragKind` union + `resolveDragEnd` + `persistIssues` persist
   path, `derive_key_chain`, `buildProjectBreadcrumb`. The three non-nesting
   kinds (status, tag, workspace) are flat **by design** — columns, labels,
   and issue-scoped M:N respectively.
2. **`sqlx` `query_as!` macros die.** ~7,021 LOC of compile-time-verified SQL
   across `crates/db/src/models/` depends on typed columns. An EAV/`nodes`+
   JSON-payload model makes every read `Node` + post-parse, loses column type
   checking, and breaks ts-rs derivation (`shared/types.ts` goes from generated
   1,200 lines to hand-written). This is the only thing sqlx gives over
   rusqlite.
3. **JSON payload = schema drift dump.** Typed columns (`priority`,
   `target_date`, `completed_at`) are self-documenting and queryable; EAV turns
   "find done issues" into `json_extract` with no index support.
4. **Blast radius, scoped:** 26 server route files → 5 at risk (~3,500 LOC),
   21 untouched (~8,000). 25 db models → 7 at risk (~1,500), 18 untouched
   (~5,500). web-core 75k LOC → kanban data layer ~6k at risk, ~65k untouched
   (chat, terminal, git, PRs, settings are nodal-agnostic).
5. **Estimate: 4–6 weeks** solo, app not bootable ~2 weeks mid-migration, plus
   regression on the DnD system that just survived 5 review passes with zero
   open bugs. Net: ~30 person-days to save ~500 LOC and gain zero user-visible
   features.
6. **DnD does not simplify.** `DragKind = 'node-move'` collapses the type, but
   the persister still dispatches: issue-move → `UPDATE issues`, column-reorder
   → `UPDATE project_statuses`, project-reorder → `UPDATE projects`. Different
   tables, different sibling scope. Dispatch just moves; net LOC ≈ 0, static
   guarantees get weaker.

## What would reverse the verdict

1. A concrete need to attach comment/workspace/tag to a non-issue node (today: none).
2. A plan for >5 entity kinds with real cross-kind nesting (today: 0).
3. Migration off sqlx to a library where EAV is ergonomic (rusqlite + serde_json).

## Preferred middle path (interest confirmed — separate high-priority TODO)

`nodes(id, node_type, parent_id, sort_order)` as a **generic adjacency
super-index layered over the existing typed tables**. Uniform tree query +
uniform DnD + breadcrumb WITHOUT rebuilding the schema. ~1 new table + a tree
router + rewriting `buildTreeData`. Days, not weeks; additive (safe) migration.

Tracked separately: `docs/TODO/nodes-superindex.md`.

## Escalate-glm's 4 targeted moves (alternatives, cheaper than the index)

1. Ship ADR-013 project-reorder DnD (already specced, `persistProjectReorder` exists).
2. Add `column-reorder` DragKind (variant reserved in ADR-012, resolver returns
   `invalid` today).
3. Typed `node_attachments(host_kind, host_id, attached_kind, attached_id)`
   overlay — only if a real cross-kind attach driver appears; half a day when needed.
4. Collapse the 3 tree builders via a recursive-CTE **view** over typed tables
   (e.g. `hierarchy_edges`) — ~200 LOC, optional.
