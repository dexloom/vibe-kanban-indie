/**
 * Pure data shapes for the kanban-internal move path. Lives in the
 * model layer so pure logic (`computeKanbanMove`, its tests) does not
 * have to import React wiring from `KanbanDragHandlerContext`.
 *
 * The context module re-exports both names for call sites that already
 * import them from there.
 */
export interface KanbanMove {
  issueId: string;
  fromStatusId: string;
  toStatusId: string;
  /** Insertion slot in the destination column (how many cards sit above).
   * `undefined`/null appends to the end (legacy list-view path). */
  index?: number | null;
  /** When set, this is a same-column SWAP of two cards (not a move): the
   * board swaps `issueId` and `swapWithIssueId` in the destination column
   * and persists their `status_id` + `sort_order` exchange. */
  swapWithIssueId?: string | null;
}

export type KanbanDragHandler = (move: KanbanMove) => void;
