import type { KanbanMove } from './kanbanMove';

/**
 * Pure local-move step: remove the issue from its source column and insert
 * it into the destination column at `move.index` (default: append). Returns
 * a new items map; does not mutate the input.
 *
 * Same-status drops:
 *  - WITHOUT an explicit index → return the input unchanged (no-op; the
 *    kanban container's `handleKanbanMove` early-returns in this case too).
 *  - WITH an explicit index → perform a positional reorder inside the
 *    same column: filter the source id out, clamp the index into the
 *    resulting column, and splice the id back in. The legacy list-view
 *    adapter (hello-pangea) is the only producer that hits this path.
 */
export function computeKanbanMove(
  prev: Record<string, string[]>,
  move: KanbanMove
): Record<string, string[]> {
  const { issueId, fromStatusId, toStatusId, index } = move;
  if (fromStatusId === toStatusId) {
    if (index === undefined || index === null) return prev;
    const column = [...(prev[fromStatusId] ?? [])].filter(
      (id) => id !== issueId
    );
    const insertAt = Math.max(0, Math.min(index, column.length));
    column.splice(insertAt, 0, issueId);
    return { ...prev, [fromStatusId]: column };
  }
  const sourceItems = [...(prev[fromStatusId] ?? [])].filter(
    (id) => id !== issueId
  );
  const destItems = [...(prev[toStatusId] ?? [])].filter(
    (id) => id !== issueId
  );
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
