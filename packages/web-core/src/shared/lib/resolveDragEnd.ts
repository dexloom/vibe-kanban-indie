import type { DropResult } from '@hello-pangea/dnd';

/**
 * Minimal shape the resolver needs from an Issue row. The full `Issue`
 * type carries much more; we only project what's required so callers can
 * cheaply build this map from a shape collection without re-rendering
 * downstream consumers.
 */
export interface IssueDragLookup {
  id: string;
  project_id: string;
  status_id: string;
}

export type DragOutcome =
  | { type: 'no-op' }
  | { type: 'kanban-internal'; result: DropResult }
  | {
      type: 'move-issue';
      issueId: string;
      targetStatusId: string;
      projectId: string;
    }
  | { type: 'invalid'; reason: string };

type ParsedSurface =
  | { surface: 'kanban'; statusId: string; projectId: string }
  | { surface: 'tree-status'; statusId: string; projectId: string }
  | { surface: 'tree-card'; statusId: string; projectId: string };

type ParseResult =
  ParsedSurface | { invalid: 'cross-project' } | { invalid: true };

const ISSUE_DROPPABLE_PREFIX = 'issue:';
const TREE_STATUS_PATTERN = /^([^:]+):status:(.+)$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a droppableId into one of three surfaces used by the resolver:
 *  - `kanban`: bare UUID status column (kanban board)
 *  - `tree-status`: `<projectId>:status:<statusId>` (sidebar status row)
 *  - `tree-card`: bare UUID that resolves to an Issue via `issuesById`
 *    (sidebar card row's per-card droppable added by the cross-surface
 *    step — see PLAN §6.5 / CardNodeRow)
 *
 * Distinguishing kanban vs tree-card is purely positional: a bare UUID that
 * is `issuesById` is a card; the same shape that isn't is a kanban column.
 * A status dropped with the wrong project prefix is rejected as cross-project.
 */
function parseDroppableId(
  droppableId: string,
  activeProjectId: string,
  issuesById: ReadonlyMap<string, IssueDragLookup>
): ParseResult {
  const treeStatus = TREE_STATUS_PATTERN.exec(droppableId);
  if (treeStatus) {
    const parsedProjectId = treeStatus[1];
    if (parsedProjectId !== activeProjectId) {
      return { invalid: 'cross-project' };
    }
    return {
      surface: 'tree-status',
      statusId: treeStatus[2],
      projectId: parsedProjectId,
    };
  }

  // Bare UUID — could be a kanban column or a tree card.
  if (!UUID_PATTERN.test(droppableId)) {
    return { invalid: true };
  }

  const issue = issuesById.get(droppableId);
  if (issue) {
    if (issue.project_id !== activeProjectId) {
      return { invalid: 'cross-project' };
    }
    return {
      surface: 'tree-card',
      statusId: issue.status_id,
      projectId: issue.project_id,
    };
  }

  return {
    surface: 'kanban',
    statusId: droppableId,
    projectId: activeProjectId,
  };
}

/**
 * Resolve a hello-pangea `onDragEnd` result into one of four outcomes:
 *
 *  - `no-op`            — nothing meaningful changed (no destination, no real move).
 *  - `kanban-internal`  — both source and destination are bare-UUID kanban columns;
 *                         delegate to the kanban board's existing handler.
 *  - `move-issue`       — at least one side is a tree droppable; fire
 *                         `bulkUpdateIssues` with the resolved target status.
 *  - `invalid`          — reason is logged and the drop is silently snapped back.
 *
 * The function is pure: callers supply `activeProjectId` and `issuesById` so the
 * implementation never closes over stale state (PLAN §11 risk mitigation).
 */
export function resolveDragEnd(
  result: DropResult,
  activeProjectId: string | null,
  issuesById: ReadonlyMap<string, IssueDragLookup>
): DragOutcome {
  const { destination, source, draggableId } = result;

  // 1. destination === null → no-op (dropped outside any droppable)
  if (!destination) return { type: 'no-op' };

  // 2. No active project (e.g. landing page)
  if (!activeProjectId) {
    return { type: 'invalid', reason: 'no active project' };
  }

  // 3. draggableId must carry the "issue:" prefix
  if (!draggableId.startsWith(ISSUE_DROPPABLE_PREFIX)) {
    return { type: 'invalid', reason: 'not an issue' };
  }
  const issueId = draggableId.slice(ISSUE_DROPPABLE_PREFIX.length);
  if (!issueId) {
    return { type: 'invalid', reason: 'not an issue' };
  }

  // 4. Issue must be present in the lookup
  const issue = issuesById.get(issueId);
  if (!issue) {
    return { type: 'invalid', reason: 'unknown issue' };
  }

  // 5. Active-project guard (the drag-source can't be from another project
  // because the sidebar tree only renders cards for expanded tasks projects,
  // but the kanban path can theoretically cross projects.)
  if (issue.project_id !== activeProjectId) {
    return { type: 'invalid', reason: 'cross-project' };
  }

  // 6. Destination must parse as one of the valid status targets
  const parsedDest = parseDroppableId(
    destination.droppableId,
    activeProjectId,
    issuesById
  );
  if ('invalid' in parsedDest) {
    return {
      type: 'invalid',
      reason:
        parsedDest.invalid === 'cross-project'
          ? 'cross-project'
          : 'not a valid status target',
    };
  }

  // 7. Same droppableId and same index → true no-movement (e.g. mouseup on
  //    the same card that was lifted). Drops to the same column at a
  //    different index still fall through to step 8 (kanban-internal).
  if (
    source.droppableId === destination.droppableId &&
    source.index === destination.index
  ) {
    return { type: 'no-op' };
  }

  // 8. Both source and destination are kanban columns → delegate to the
  //    kanban board's existing handler (it owns sort_order recalculation).
  const parsedSource = parseDroppableId(
    source.droppableId,
    activeProjectId,
    issuesById
  );
  if (
    'surface' in parsedSource &&
    parsedSource.surface === 'kanban' &&
    parsedDest.surface === 'kanban'
  ) {
    return { type: 'kanban-internal', result };
  }

  // 9. Anything else (cross-surface or tree→tree) → caller fires a single
  //    bulkUpdateIssues with the destination status.
  //
  //    Same-status guard: if the resolved target status equals the source
  //    issue's current status, collapse to no-op so the caller doesn't
  //    fire a redundant bulkUpdateIssues (the custom tree drag manager may
  //    resolve a sloppy drop onto the issue's own status, and the kanban
  //    path can land a kanban→tree drop onto the same status). The guard
  //    runs AFTER the kanban-internal branch so same-column kanban
  //    reorders (manual sort) still update sort_order via the kanban
  //    handler — a reorder isn't a status change.
  if (parsedDest.statusId === issue.status_id) {
    return { type: 'no-op' };
  }

  return {
    type: 'move-issue',
    issueId,
    targetStatusId: parsedDest.statusId,
    projectId: parsedDest.projectId,
  };
}
