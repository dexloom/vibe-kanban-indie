import type { Workspace } from 'shared/remote-types';

/**
 * Deterministically pick the "current run" workspace out of all workspaces
 * linked to a card, for rendering that run's live pipeline progress.
 *
 * An issue can have many linked workspaces (re-runs, experiments). The
 * linked-workspace API shape (`shared/remote-types.ts` `Workspace`) has no
 * `is_running` flag, so "newest linked, non-archived run" is the
 * deterministic proxy for "the active run": newest by `created_at` desc,
 * tie-broken by `updated_at` desc then `id` desc — matching the API's own
 * `ORDER BY created_at DESC`.
 *
 * Returns `null` when there is no non-archived workspace to pick.
 */
export function selectActiveWorkspace(
  workspaces: readonly Workspace[]
): Workspace | null {
  let best: Workspace | null = null;
  for (const ws of workspaces) {
    if (ws.archived) continue;
    if (best === null || compareWorkspaceRecency(ws, best) > 0) {
      best = ws;
    }
  }
  return best;
}

/** Positive when `a` is more recent (should sort first) than `b`. */
function compareWorkspaceRecency(a: Workspace, b: Workspace): number {
  const createdDiff = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (createdDiff !== 0) return createdDiff;
  const updatedDiff = Date.parse(a.updated_at) - Date.parse(b.updated_at);
  if (updatedDiff !== 0) return updatedDiff;
  return a.id.localeCompare(b.id);
}
