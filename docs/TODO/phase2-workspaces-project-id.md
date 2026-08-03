# Phase 2 — `workspaces.project_id` migration (deferred, ~weeks out)

**Status**: Deferred (see ADR-007). **Owner decision**: do this much later (weeks).
Do NOT start until this task is picked up.

## Why

The global sidebar tree groups workspaces under projects (ADR-007). Today the
grouping is **frontend-derived** from the `issue_workspaces` join
(workspace → issue → issue.project_id), so:

- Workspaces created through the GLOBAL `/workspaces_.create` flow (no issue)
  have no project and appear under an "Unassigned" pseudo-project.
- "Project-bound" is really "has an issue link into that project" — M:N, and
  misleading for workspaces that never had an issue.

## The change (when picked up)

1. Migration: `ALTER TABLE workspaces ADD COLUMN project_id BLOB REFERENCES projects(id) ON DELETE SET NULL;`
2. Set at create: `crates/local-deployment` / `useCreateWorkspace` already has
   `CreateModeInitialState.project_id` in scope (`packages/web-core/src/shared/lib/workspaceCreateState.ts`);
   pass it into the workspace-create payload so the local row records the project.
3. Backfill existing rows from the join:
   ```sql
   UPDATE workspaces
   SET project_id = (
     SELECT i.project_id
     FROM issue_workspaces iw
     JOIN issues i ON i.id = iw.issue_id
     WHERE iw.workspace_id = workspaces.id
     LIMIT 1
   );
   ```
4. Frontend: `useWorkspaceProjectMembership` becomes trivial (`SidebarWorkspace.project_id`);
   the "Unassigned" group only shows workspaces with `project_id IS NULL`.

## Also unlocks

Future per-project sections in the sidebar tree (TODOs, Notes, etc.) — they will
be `project_id`-scoped rows in their own tables, same pattern.
