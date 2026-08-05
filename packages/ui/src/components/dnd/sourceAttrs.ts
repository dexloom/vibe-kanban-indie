/**
 * Shared list of data attributes the drag system attaches to source
 * elements (the captured drag origin and its descendants). Every clone
 * that escapes the source — the drag ghost in `DragController` and
 * the cross-column insertion preview in `KanbanBoard` — must strip
 * these attributes so the clone is never picked up by `collectTargets`
 * (which re-queries the DOM each frame) and never collides with a
 * live source element that shares the same id namespace.
 *
 * Keep this list authoritative: adding a new `data-dnd-*` or
 * `data-drop-target-*` attribute to a draggable / drop target means
 * extending this list too. Two consumers exist today
 * (`DragController.createGhost`, `KanbanCards` cross-column preview
 * effect) and both iterate this constant.
 */
export const SOURCE_DATA_ATTRS = [
  'data-dnd-card',
  'data-dnd-card-issue-id',
  'data-drop-target-id',
  'data-drop-target-project',
  'data-drop-target-status',
  'data-drop-target-accept-kinds',
  'data-drop-target-parent-id',
] as const;

export type SourceDataAttr = (typeof SOURCE_DATA_ATTRS)[number];
