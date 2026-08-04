import type { KanbanMove } from './kanbanMove';

/**
 * Pure local-move step: remove the issue from its source column and insert
 * it at `destIndex` (or append) in the destination column. Returns a new
 * items map; does not mutate the input. Co-located in its own module so
 * it can be unit-tested without dragging in the heavy kanban container
 * (and its `ExecutorConfigForm` chain). The same-status no-op guard
 * above `handleKanbanMove` is the only place that decides whether to
 * call.
 */
export function computeKanbanMove(
  prev: Record<string, string[]>,
  move: KanbanMove
): Record<string, string[]> {
  const { issueId, fromStatusId, toStatusId, destIndex } = move;
  const sourceItems = [...(prev[fromStatusId] ?? [])].filter(
    (id) => id !== issueId
  );
  // Only filter `destItems` when the move is a same-column reorder. On
  // cross-column moves the issue can't already live in the destination
  // (issue.status_id === fromStatusId ≠ toStatusId), so the filter was a
  // no-op; skipping it is a constant-factor win and keeps the cross-column
  // path simple.
  const rawDest = prev[toStatusId] ?? [];
  const destItems =
    fromStatusId === toStatusId
      ? rawDest.filter((id) => id !== issueId)
      : [...rawDest];
  const clamped =
    destIndex != null
      ? Math.max(0, Math.min(destIndex, destItems.length))
      : destItems.length;
  destItems.splice(clamped, 0, issueId);
  return {
    ...prev,
    [fromStatusId]: sourceItems,
    [toStatusId]: destItems,
  };
}
