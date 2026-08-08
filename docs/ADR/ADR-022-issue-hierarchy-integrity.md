# ADR-022: Issue hierarchy integrity guards and delete semantics

- **Status**: Accepted
- **Date**: 2026-08-08
- **Relates to**: ADR-013 (project boards), ADR-016 (board orchestrator)

## Context

`parent_issue_id` was written verbatim on both write paths (create and the
PATCH merge). Nothing rejected:

- self-parenting (`A→A`),
- cycles (`A→B→A`),
- a parent in a different project,
- a nonexistent parent (caught only as an opaque SQLite FK error).

The frontend's outliner (`buildTreeData`) truncated cycles when rendering,
and the orchestrator plugin carried its own visited-set guards — every
consumer had to defend itself because the store allowed invalid edges in.

Separately, deleting a parent silently set its children's `parent_issue_id`
to `NULL` via the schema's `ON DELETE SET NULL`, an undocumented behaviour.

## Decision

### 1. Write-time validation (`validate_issue_parent`)

Both write paths now validate the proposed parent before any row is written,
with **distinct** `BadRequest` errors:

| Condition | Error |
|---|---|
| `parent == child` (`A→A`) | `issue cannot be its own parent` |
| parent row missing | `parent issue not found` |
| `parent.project_id != child.project_id` | `parent issue is in a different project` |
| child id reached while walking the parent's ancestors | `parent issue would create a cycle` |

Cycle detection walks the proposed parent's ancestor chain with a visited
set, following `parent_issue_id` to the root. The visited set also guards
against looping forever on pre-existing anomalies (defence in depth; such
rows can no longer be created).

The guard is applied in two shared chokepoints so **both** routers
(`/v1/issues` and the local fallback mutations) and the bulk-PATCH path are
covered by one implementation:

- `create_issue_record` (`routes/local_kanban.rs`) — project existence +
  parent validation + key-chain derivation + insert; called by both
  `create_issue` handlers.
- `merge_and_update_issue` — validates only an explicit **changed** parent
  (`Some(Some(pid))` where `pid != existing`). Keeping the existing parent
  (`None`) and clearing it (`Some(None)`) skip validation: clearing can
  never introduce a cycle or cross-project edge, and re-validating an
  unchanged value would brick edits to any legacy bad row.

### 2. Delete semantics: promote children to roots (documented, kept)

`ON DELETE SET NULL` is **intended**: deleting a parent promotes its
children to roots. Grandchildren (and deeper) are untouched — their chains
still resolve. Alternatives considered:

- **Cascade** — silently destroying a subtree of cards is too destructive
  for a board where deletion is one click.
- **Restrict** — would force users to manually reparent or delete children
  first; friction with no corresponding benefit for a solo-dev tool.

The behaviour is pinned by
`delete_parent_promotes_children_to_roots` in `local_kanban.rs` tests.

### 3. Frontend truncation stays as belt-and-braces

`buildTreeData`'s cycle truncation (and its tests) is unchanged. It is no
longer the only guard, but remains as rendering defence against any legacy
row written before this ADR.

## Consequences

- A consumer can walk a parent chain to the root without carrying its own
  visited-set guard, for any row written after this change.
- A one-off query against the live board DB confirmed **zero** existing
  cycles, self-parents, and cross-project parents before the guard was
  added, so no legacy row is bricked by the strict write path.
- No depth limit is imposed on issue nesting (project chains already cap at
  16 via `derive_key_chain`; unbounded issue depth is fine).
