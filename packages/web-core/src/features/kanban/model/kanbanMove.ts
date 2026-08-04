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
}

export type KanbanDragHandler = (move: KanbanMove) => void;
