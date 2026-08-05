import {
  bulkUpdateIssues,
  bulkUpdateProjects,
  type BulkUpdateIssueItem,
  type BulkUpdateProjectItem,
} from '@/shared/lib/remoteApi';
import { refreshShapeSource } from '@/shared/lib/electric/collections';
import { PROJECT_ISSUES_SHAPE, PROJECTS_SHAPE } from 'shared/remote-types';

export interface PersistIssuesOptions {
  onError?: (err: unknown) => void;
  /** Runs after success OR failure (e.g. decrement isSyncingCountRef). */
  onSettled?: () => void;
}

export interface PersistIssueSwapPair {
  id: string;
  changes: { status_id: string; sort_order: number };
}

/**
 * Fire a bulk issue update + resync the project issues shape. Centralised
 * so every drop / drag-commit path shares the same error handling and
 * post-write shape refresh — the smarts (decrement `isSyncingCountRef`, log
 * under the right tag) stay at the call site via `onError` / `onSettled`.
 *
 * The shape refresh runs on BOTH success and failure so the optimistic
 * local state is resynced against the authoritative backend whenever the
 * REST call resolves (the failed path leaves the backend untouched, so the
 * refresh simply restores the old order).
 */
export function persistIssues(
  updates: BulkUpdateIssueItem[],
  projectId: string,
  options?: PersistIssuesOptions
): void {
  const refresh = () =>
    refreshShapeSource(PROJECT_ISSUES_SHAPE, { project_id: projectId });
  bulkUpdateIssues(updates)
    .then(() => {
      try {
        refresh();
      } catch {
        // Refresh failure is non-fatal — the next shape sync heals it.
        // Treating a refresh rejection as a bulk failure would mis-fire
        // `onError` and double-trigger the refresh.
      }
    })
    .catch((err: unknown) => {
      options?.onError?.(err);
      refresh();
    })
    .finally(() => {
      options?.onSettled?.();
    });
}

export function persistIssueSwap(
  a: { id: string; status_id: string; sort_order: number },
  b: { id: string; status_id: string; sort_order: number },
  projectId: string,
  options?: PersistIssuesOptions
): void {
  const updates: PersistIssueSwapPair[] = [
    {
      id: a.id,
      changes: { status_id: b.status_id, sort_order: b.sort_order },
    },
    {
      id: b.id,
      changes: { status_id: a.status_id, sort_order: a.sort_order },
    },
  ];
  persistIssues(updates, projectId, options);
}

/**
 * Persist a project reorder: write `sort_order = i * STEP` for every
 * project in the swapped list, then refresh the PROJECTS_SHAPE shape.
 * The shape refresh fires on BOTH success and failure so the next
 * shape sync restores authoritative state when the bulk write failed.
 * Matches the `persistIssues` contract (shape refresh on success and
 * failure, non-callback error/success handling).
 */
export function persistProjectReorder(
  swapped: { id: string }[],
  orgId: string,
  options?: PersistIssuesOptions
): void {
  const STEP = 100;
  const updates: BulkUpdateProjectItem[] = swapped.map((p, i) => ({
    id: p.id,
    changes: { sort_order: i * STEP },
  }));
  const refresh = () =>
    refreshShapeSource(PROJECTS_SHAPE, { organization_id: orgId });
  bulkUpdateProjects(updates)
    .then(() => {
      try {
        refresh();
      } catch {
        // Non-fatal: next shape sync heals it.
      }
    })
    .catch((err: unknown) => {
      options?.onError?.(err);
      refresh();
    })
    .finally(() => {
      options?.onSettled?.();
    });
}
