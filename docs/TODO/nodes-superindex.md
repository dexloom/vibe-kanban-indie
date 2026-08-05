# `nodes` generic adjacency super-index — high priority

**Status**: HIGH PRIORITY (owner-confirmed interest, 2026-08-05). Not yet started.
**Source**: nodal-engine exploration → `docs/TODO/nodal-engine-notes.md` (full rewrite
rejected; this index is the middle path).

## Why

The app is already ~80% hierarchical (projects `parent_id`, issues
`parent_issue_id`, threaded comments, edge tables), but there is **no single
place** to ask "walk everything under X regardless of kind". Today:

- Tree building is per-kind: `buildTreeData` (projects), issue-tree builder
  (KanbanContainer), comment-tree builder — three recursive walks.
- DnD `DragKind` union + `resolveDragEnd` dispatch per kind.
- Breadcrumb walks only the project chain.
- Cross-kind attachment (e.g. a workspace or note under an arbitrary project
  node) has no home.

The goal is NOT to rebuild the schema (that is rejected). It is a **thin
adjacency layer** giving a uniform tree query, uniform DnD positioning, and a
uniform breadcrumb, with an **additive (safe) migration**.

## The change (when picked up)

1. **Migration** (additive — same safety class as ADR-013's `ADD COLUMN`, never
   table recreation):

   ```sql
   CREATE TABLE nodes (
     id          BLOB PRIMARY KEY,
     node_type   TEXT NOT NULL,             -- 'project'|'issue'|'status'|'comment'|'workspace'|...
     parent_id   BLOB,                      -- REFERENCE into the same typed tables, NOT a self-FK
     sort_order  REAL NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL DEFAULT (datetime('now','subsec'))
   );
   CREATE INDEX idx_nodes_parent ON nodes(parent_id, sort_order);
   CREATE INDEX idx_nodes_type  ON nodes(node_type);
   ```

   Design open questions to settle first:
   - Is `nodes.id` a new UUID, or reused as the existing entity id (project.id,
     issue.id)? Reusing id = no migration backfill of entity rows, but a `nodes`
     row must be created/maintained alongside each entity insert. Decide before
     writing the router.
   - Who owns the row lifecycle — entity `create`/`delete` handlers write the
     `nodes` row in the same transaction, or a trigger? Same-transaction handler
     write is preferred (explicit, testable).
   - Do statuses/workspaces participate, or does the index start at
     project+issue+comment (the kinds that actually nest)?
2. **Tree router** (`crates/server`): one endpoint returning a uniform subtree
   via a recursive CTE over `nodes`:
   ```sql
   WITH RECURSIVE walk AS (
     SELECT node_type, id, parent_id, sort_order, 0 AS depth FROM nodes WHERE id = ?
     UNION ALL
     SELECT n.node_type, n.id, n.parent_id, n.sort_order, w.depth + 1
     FROM nodes n JOIN walk w ON n.parent_id = w.id
   ) SELECT * FROM walk;
   ```
3. **Frontend**: collapse `buildTreeData` + the issue/comment builders onto the
   uniform tree shape; breadcrumb becomes `walk`-derived.
4. **DnD**: optional later — uniform `node-move` positioning over the index.

## Constraints / warnings

- **Migration must stay additive.** No DROP/table recreation — the ADR-013
  sqlx data-loss trap (FK no-op under transactional migrations) applies to any
  rewrite. Freeze the migration after first run (checksum).
- `nodes.parent_id` is NOT a self-FK into `nodes(id)` unless `nodes.id` reuses
  entity ids AND entities are guaranteed present; otherwise it references the
  typed tables and integrity is enforced by the write path, not the schema.
- Keep sqlx `query_as!` compile-time checks alive — the index must not force
  EAV/JSON payloads.
- This is a ~days effort (1 table + router + `buildTreeData` rewrite), not the
  multi-week full-nodal rewrite.

## Rejected alternative

Full nodal engine (EAV/typed-collapse/closure-table) — see
`docs/TODO/nodal-engine-notes.md` for the escalation verdict and blast radius.
