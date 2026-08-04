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
  /** Destination position; omit to append. Set only by the legacy list-view
   * adapter (positional reorder); custom cross-surface drags always emit a
   * numeric `completion.index` for kanban-column hits (threaded as
   * `destIndex: number`), so `destIndex === undefined` means append. */
  destIndex?: number;
}

export type KanbanDragHandler = (move: KanbanMove) => void;
