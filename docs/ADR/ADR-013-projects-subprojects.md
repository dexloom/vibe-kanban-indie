# ADR-013: Project subprojects — nested projects with per-scope kanban

- **Status**: Accepted
- **Date**: 2026-08-05
- **Amended**: 2026-08-05 (two-architect escalation + synthesis; see "Synthesis (2026-08-05)")
- **Relates to**: ADR-012 (custom drag-and-drop), ADR-007 (sidebar tree), ADR-011 (Tasks section)

## Context

Projects are currently a **flat** list: `projects` has no `parent_id`, the sidebar tree
renders `projects.map(...)` as a single level, the router is `/projects/:projectId`, and
project reorder is a global flat swap. A "big project made of small subprojects" requires
hierarchical projects, each scope owning its own kanban.

The existing model already anticipates hierarchy in two places:

- **Issues are hierarchical**: `parent_issue_id` + `parent_issue_sort_order` nest
  sub-issues recursively (`CardNode.children`). The pattern works.
- **Kanban is already per-project**: `KanbanContainer` is parameterised by `projectId`,
  `PROJECT_ISSUES_SHAPE` is scoped by `project_id`. Any project id renders its own board.

What is flat today: the `projects` table/schema, the `Project` struct, the sidebar tree
builder, the router, the DnD cross-project guard, and `sort_order` reordering.

## Owner decisions (2026-08-05)

1. **Subproject key format**: `ACME-SUB-1` — the subproject inherits its parent key as a
   prefix, appends its own key segment, and numbers issues per subproject. Format:
   `<parent-key>-<sub-key>-<n>`. Root projects stay `ACME-1`. Deeper nesting:
   `ACME-SUB-X-1` (prefix chain).
2. **Parent projects have their own kanban**: a project with children is still a kanban
   scope. Kanban is an **attachable entity** — any project node (root or nested) owns a
   board; subprojects nest under it in the tree but do not replace it.
3. **Break API + schema freely for elegance, but ship migration scripts** for existing
   users. Existing flat projects become roots with no parent. No data loss: existing
   issues keep their `simple_id` / `issue_number`.

## Synthesis (2026-08-05)

Two independent architect reviews + a synthesis review produced these refinements (the
four TO RESOLVE items and the migration mechanics are now settled):

1. **Key separator `-` confirmed** — `derive_key` (`local_kanban.rs:368-380`) strips all
   non-alphanumeric chars, so a root project named `ACME-SUB` derives to `ACME` (not
   `ACMESUB`); the proposed `.` separator buys zero extra safety. The user's `-` stands.
2. **No `key_path` column** — `Project.key` is immutable post-create (`update_fields`
   preserves `existing.key`, `local_kanban.rs:309`). The chain is **derived per issue
   create** via `derive_key_chain(pool, project_id)` (walks `parent_id` to root, joins
   segments with `-`, cap 16 levels). Denormalising would add a maintenance column that a
   future reparent feature would force to rewrite per-subtree.
3. **ALTER TABLE ADD COLUMN with a NULL-default REFERENCES clause DOES enforce FKs** —
   the original incident was caused by a `DROP TABLE projects` under active FKs in a
   sqlx transaction (where `PRAGMA foreign_keys = OFF` is a no-op), NOT by `ADD COLUMN`.
   `ADD COLUMN ... REFERENCES projects(id) ON DELETE RESTRICT` with the column defaulting
   to NULL is enforced normally — verified by `project_parent_round_trips_and_restricts_parent_deletion`
   in `crates/db/src/models/project.rs`. **Table recreation is unsafe under sqlx** because
   each migration runs inside a transaction where `PRAGMA foreign_keys = OFF` is a no-op;
   a `DROP TABLE projects` therefore executes with foreign keys ENABLED, SQLite
   performs an implicit `DELETE FROM projects`, and `ON DELETE CASCADE` wipes `issues`,
   `project_statuses`, `project_repos`, `kanban_tags`, `tasks`. This destroyed a user's
   kanban data during development. `ALTER TABLE ADD COLUMN` never touches existing rows
   and is the only safe shape for this additive schema change under sqlx.
4. **`ON DELETE` RESTRICT** — a parent with children cannot be deleted implicitly;
   `delete_project` pre-checks `count_children` and returns 409 with the child list.
   The count+delete runs in a single transaction (F-5) so a concurrent INSERT can't
   slip past the check; the FK is the second line of defence, mapped to the same
   `ConflictPayload` if it fires.
5. **DnD**: cross-project issue-move stays **blocked** (exact-project guard unchanged);
   project-reorder becomes **sibling-only** (same `parent_id`). Reparenting via drag is
   out of scope — a later explicit action.
6. **Router unchanged** — leaf-only `/projects/:projectId`; the hierarchy is data-derived,
   rendered as a breadcrumb in the kanban header.

## Decision

Add hierarchical projects with per-scope kanban, keeping issues hierarchical as today.

### Data model

- `projects.parent_id: Option<Uuid>` — nullable self-FK, `REFERENCES projects(id) ON
  DELETE RESTRICT`. `NULL` = root project. Added via table-recreation migration
  (see §Migration).
- `projects.key`: stays the per-project key segment. `simple_id` = `derive_key_chain`
  (parent chain joined with `-`) + `-{issue_number}`. No `key_path` column.
- `projects.sort_order`: per-parent ordering (siblings sort against each other). Root
  ordering unchanged. `ORDER BY` becomes `(parent_id, sort_order)` where relevant.
- `Issue.issue_number` remains per-project (each kanban scope numbers independently);
  `Issue::create` already takes `key: &str` — unchanged.
- **Per-parent key uniqueness**: enforced at `create_project` (sibling with a colliding
  derived key → 400). This is the real collision surface; the separator is irrelevant.

### Sidebar tree

- `buildTreeData` becomes recursive: group `projects` by `parent_id`, build nested
  `ProjectNode`s. A root renders its own Tasks + Workspaces sections, then child
  subprojects as nested project rows.
- `SidebarProject` gains `parentId: string | null`; `ProjectNode.children` widens from
  `SectionNode[]` to `(SectionNode | ProjectNode)[]`.
- Node ids stay `${projectId}` (UUID — unique across the tree); open-state persistence
  unchanged (`openState.ts` project-node filter works as-is). Child rows indent by depth.

### Router

- **Unchanged** — leaf-only `/projects/:projectId`. Active project = leaf id.
  Breadcrumb in the `KanbanContainer` header walks the `parent_id` chain client-side;
  clicking a segment navigates to that project's id.

### Kanban (attachable entity)

- No change to `KanbanContainer`'s per-project contract — each project id (root or
  subproject) already renders its own board. Zero board change.

### DnD

- Cross-project issue-move stays **blocked**: `DragController.ts:506` exact-project guard
  unchanged.
- Project-reorder restricted to **siblings** (same `parent_id`): `DragSource` gains
  `parentId`, project rows gain `data-drop-target-parent-id`, `collectTargets` filters
  non-siblings.
- Reparenting via drag is out of scope (later ADR / explicit action).

### Project reorder

- **Siblings-only**. `SharedAppLayout` slices the dragged project's sibling group (same
  `parent_id`), swaps within it, and persists only those siblings via
  `persistProjectReorder`. `sortProjectsByOrder` sorts by `(parent_id, sort_order)`.

## Consequences

### Positive

- Kanban stays a per-project entity — zero change to the board itself.
- Issues stay hierarchical — the recursive tree/`parent_issue_id` pattern is proven.
- Migration is additive (nullable `parent_id`, `NULL` backfill) — existing data intact.
- Router, DnD issue-move, and `Issue::create` are unchanged — small surface area.

### Negative / accepted

- Tree builder + reorder + project-reorder DnD touch the "project is flat" assumption —
  the bulk of the work.
- Key-chain derivation walks ancestors per issue creation (one query, depth ≤ ~5).
- Parent-scoped `sort_order` changes the project-reorder flow.
- Deleting a parent with children now fails with 409 until children are removed first.

### Risks

- Regressing project reorder / DnD guard / tree open-state persistence.
- Per-parent key uniqueness: mitigated by the `create_project` sibling check.

## Migration (for existing users)

> **FROZEN FILE — DO NOT EDIT** —
> `crates/db/migrations/20260805000001_add_project_parent_id.sql` is
> **frozen** after release. The migration SHA-384 checksum is recorded
> in `_sqlx_migrations` on first run; any byte change to the file
> (even whitespace, even a comment) makes the checksum drift and the
> server refuses to start on macOS/Linux (`VersionMismatch` in
> `crates/db/src/lib.rs`). A re-run on a corrupted `_sqlx_migrations`
> table would also fail at `CREATE INDEX` (these statements are not
> `IF NOT EXISTS`-guarded in this migration); recovery is to drop the
> matching `_sqlx_migrations` row manually. A guard script
> (`scripts/check-migration-frozen.sh`, `pnpm check:db`) compares the
> working tree against the committed version and exits non-zero on
> drift.

`ALTER TABLE ADD COLUMN` with an inline `REFERENCES` — NOT the table-recreation
pattern. SQLite supports a `REFERENCES` clause on `ADD COLUMN` when the column
defaults to `NULL` (it does — subprojects are optional), and FK enforcement
applies normally. Existing rows are untouched (all current projects become
roots with `parent_id = NULL`).

```sql
ALTER TABLE projects ADD COLUMN parent_id BLOB REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_projects_parent ON projects(parent_id);
CREATE INDEX idx_projects_sort_order ON projects(sort_order);
```

> **Data-loss trap (do NOT "fix" this back to table recreation).** sqlx runs
> each migration inside a transaction, and `PRAGMA foreign_keys = OFF` is a
> **no-op inside a transaction**. A `DROP TABLE projects` therefore executes
> with foreign keys ENABLED → SQLite performs an implicit `DELETE FROM
> projects` → `ON DELETE CASCADE` wipes `issues`, `project_statuses`,
> `project_repos`, `kanban_tags`, `tasks`. This destroyed a user's kanban data
> during development. `ALTER TABLE ADD COLUMN` never touches existing rows and
> is the only safe shape for this additive schema change under sqlx.

Rust: add `parent_id: Option<Uuid>` to `Project` + all `query_as!` lists, `create` /
`update_fields` params, plus `count_children` / `find_parent_chain_keys`; add
`derive_key_chain` in `local_kanban.rs`; add `parent_id` to the wire `Project` and
`CreateProjectRequest` in `crates/api-types`. Regenerate `shared/types.ts` via
`pnpm run generate-types`.

## Implementation order (TDD)

1. Migration + `Project.parent_id` + model queries + `count_children`.
2. `derive_key_chain` + sibling-key uniqueness at `create_project`.
3. `create_issue` uses the chain key.
4. `delete_project` 409 guard (`ApiError::Conflict`).
5. API + TUI types (`parent_id`), regenerate types.
6. Tree builder recursion (`buildTreeData`, `outliner/types.ts`).
7. DnD project-reorder sibling scoping (`DragController`, `types.ts`, `treeNodes.tsx`).
8. Reorder sibling slice (`SharedAppLayout`, `persistProjectReorder`, `sortProjectsByOrder`).
9. Breadcrumb in `KanbanContainer` header.
10. Open-state regression suite.

Each step: failing test first, then minimal change. Deferred follow-up: explicit reparent
action (sets `parent_id` + rebuilds chains for the moved subtree).
