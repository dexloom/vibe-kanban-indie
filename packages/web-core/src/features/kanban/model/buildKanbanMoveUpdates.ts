import type { BulkUpdateIssueItem } from '@/shared/lib/remoteApi';
import type { KanbanMove } from './kanbanMove';

export type CalculateSortOrder = (statusId: string, index: number) => number;

export interface BuildKanbanMoveUpdatesParams {
  /** Result of `computeKanbanMove(prev, move)` — the new column layout. */
  newItems: Record<string, string[]>;
  /** The original move (only `fromStatusId`/`toStatusId` are read here). */
  move: KanbanMove;
  /** TRUE → write `status_id` + `sort_order` for every dest card and
   *  `sort_order` for every source card. FALSE → write ONLY `status_id`
   *  for the moved card (no positional reindex, no source rewrite). */
  isManualSort: boolean;
  /** Used to compute `sort_order` values when `isManualSort` is true. */
  calculateSortOrder: CalculateSortOrder;
  /** Map of every visible status id → 1-based column index. The source
   *  reindex is skipped for any from-status that isn't in this map (a
   *  deleted/hidden status). */
  statusColumnIndexMap: Map<string, number>;
}

/**
 * Decide what to persist for a cross-column kanban move.
 *
 * Manual sort (priority/created_at/title/etc. all non-`sort_order`):
 *  - The board is sorted by a non-positional field, so the controller
 *    resolved an insertion index locally only for the OPTIMISTIC preview.
 *    The persisted state should not impose a `sort_order` (the next
 *    shape sync would reorder the column anyway by the active sort).
 *  - Write ONLY `status_id` for the moved card. Skip the full dest
 *    reindex. Skip the source reindex. The previous column's order
 *    stays as-is (the card leaves; the rest keep their sort_orders).
 *
 * Manual sort (`sort_order`):
 *  - The board is sorted by sort_order, so the insert index is
 *    authoritative. Reindex every dest card's `sort_order` + the
 *    source column's `sort_order` to keep the column contiguous.
 *
 * Pure: no React, no refs. The component calls `computeKanbanMove`
 * first, then this helper, then persists.
 */
export function buildKanbanMoveUpdates(
  params: BuildKanbanMoveUpdatesParams
): BulkUpdateIssueItem[] {
  const {
    newItems,
    move,
    isManualSort,
    calculateSortOrder,
    statusColumnIndexMap,
  } = params;
  const updates: BulkUpdateIssueItem[] = [];
  const { fromStatusId: from, toStatusId: to } = move;

  if (!isManualSort) {
    // Non-manual sort: only the moving card's status changes. Avoid
    // walking every dest card (no sort_order rewrite) and every source
    // card (no source reindex). The next shape sync re-derives order
    // from the active sort field.
    updates.push({ id: move.issueId, changes: { status_id: to } });
    return updates;
  }

  const destIssueIds = newItems[to] ?? [];
  destIssueIds.forEach((id, index) => {
    updates.push({
      id,
      changes: {
        status_id: to,
        sort_order: calculateSortOrder(to, index),
      },
    });
  });
  if (from !== to && statusColumnIndexMap.has(from)) {
    const sourceIssueIds = newItems[from] ?? [];
    sourceIssueIds.forEach((id, index) => {
      updates.push({
        id,
        changes: {
          sort_order: calculateSortOrder(from, index),
        },
      });
    });
  }
  return updates;
}
