import { useMemo } from 'react';
import { useUserContext } from '@/shared/hooks/useUserContext';

/**
 * Map of `local_workspace_id` → `Set<projectId>`. ADR-007: the sidebar's
 * project-scoped tree groups workspaces under the projects they're linked to
 * (M:N, frontend-derived). Until the `workspaces.project_id` migration lands
 * (see `docs/TODO/phase2-workspaces-project-id.md`), the membership is derived
 * from the remote-shape `Workspace` rows exposed by `useUserContext` — each
 * row carries `local_workspace_id` and `project_id`.
 *
 * Semantics:
 * - A remote row with `local_workspace_id` AND a non-empty `project_id`
 *   contributes that `project_id` to the set for that `local_workspace_id`.
 * - A remote row with no `local_workspace_id` (orphaned projection) is ignored.
 * - A remote row with an empty `project_id` (workspace created via the global
 *   `/workspaces_.create` flow, no issue link) does NOT contribute; the
 *   workspace renders under the "Unassigned" pseudo-project instead.
 *
 * Callers should treat a missing key as "unassigned".
 */
export type WorkspaceProjectMembership = Map<string, Set<string>>;

export function useWorkspaceProjectMembership(): WorkspaceProjectMembership {
  const { workspaces } = useUserContext();

  return useMemo<WorkspaceProjectMembership>(() => {
    const map: WorkspaceProjectMembership = new Map();
    for (const row of workspaces) {
      const localId = row.local_workspace_id;
      const projectId = row.project_id;
      if (!localId || !projectId) continue;
      let set = map.get(localId);
      if (!set) {
        set = new Set<string>();
        map.set(localId, set);
      }
      set.add(projectId);
    }
    return map;
  }, [workspaces]);
}
