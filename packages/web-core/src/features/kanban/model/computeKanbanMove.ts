import type { KanbanMove } from './kanbanMove';

/**
 * Pure local-move step: remove the issue from its source column and insert
 * it into the destination column at `move.index` (default: append). Returns
 * a new items map; does not mutate the input. Same-status moves return the
 * input unchanged — the resolver / drag controller decides whether a
 * same-status drop is a no-op (self-target) or a real move.
 */
export function computeKanbanMove(
  prev: Record<string, string[]>,
  move: KanbanMove
): Record<string, string[]> {
  const { issueId, fromStatusId, toStatusId, index } = move;
  if (fromStatusId === toStatusId) return prev;
  const sourceItems = [...(prev[fromStatusId] ?? [])].filter(
    (id) => id !== issueId
  );
  const destItems = [...(prev[toStatusId] ?? [])];
  const insertAt =
    index === undefined || index === null
      ? destItems.length
      : Math.max(0, Math.min(index, destItems.length));
  destItems.splice(insertAt, 0, issueId);
  return {
    ...prev,
    [fromStatusId]: sourceItems,
    [toStatusId]: destItems,
  };
}
