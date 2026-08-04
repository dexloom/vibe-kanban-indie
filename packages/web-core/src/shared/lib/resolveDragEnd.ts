import type {
  DragCompletion,
  DragSource,
  Placement,
} from '@vibe/ui/components/dnd';

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
  | {
      type: 'kanban-internal';
      issueId: string;
      fromStatusId: string;
      toStatusId: string;
      projectId: string;
      destIndex?: number;
    }
  | {
      type: 'move-issue';
      issueId: string;
      targetStatusId: string;
      projectId: string;
    }
  | { type: 'invalid'; reason: string };

type ParsedSurface =
  | { surface: 'kanban'; statusId: string; projectId: string }
  | { surface: 'tree-status'; statusId: string; projectId: string };

type ParseResult =
  | ParsedSurface
  | { invalid: 'cross-project' }
  | { invalid: 'not-a-target' }
  | { invalid: 'not-a-valid-status-target' };

const TREE_STATUS_PATTERN = /^([^:]+):status:(.+)$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a targetId into one of two surfaces used by the resolver:
 *  - `kanban`: bare UUID status column (kanban board)
 *  - `tree-status`: `<projectId>:status:<statusId>` (sidebar status row)
 *
 * Cards are no longer drop targets in the cross-surface path, so a bare
 * UUID that matches an issue is rejected as `not-a-target` (defensive —
 * the layout never paints a card with `data-drop-target-id`, but if a
 * future regression does, the resolver refuses to treat it as a status).
 */
function parseTargetId(
  targetId: string,
  activeProjectId: string,
  issuesById: ReadonlyMap<string, IssueDragLookup>
): ParseResult {
  const treeStatus = TREE_STATUS_PATTERN.exec(targetId);
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

  if (!UUID_PATTERN.test(targetId)) {
    return { invalid: 'not-a-valid-status-target' };
  }

  if (issuesById.has(targetId)) {
    return { invalid: 'not-a-target' };
  }

  return {
    surface: 'kanban',
    statusId: targetId,
    projectId: activeProjectId,
  };
}

/**
 * Resolve a `DragCompletion` (the unified custom drag system's drop
 * payload) into one of four outcomes:
 *
 *  - `no-op`            — nothing meaningful changed (drag kind unsupported,
 *                         same-status drop, or no destination).
 *  - `kanban-internal`  — destination is a bare-UUID kanban column; delegate
 *                         to the kanban board's existing handler.
 *  - `move-issue`       — destination is a tree-status row OR a kanban column
 *                         AND the source is an issue-move; the layout fires
 *                         `bulkUpdateIssues` with the resolved target status.
 *  - `invalid`          — reason is logged and the drop is silently snapped
 *                         back.
 *
 * The function is pure: callers supply `activeProjectId` and `issuesById`
 * so the implementation never closes over stale state.
 */
export function resolveDragEnd(
  completion: DragCompletion,
  activeProjectId: string | null,
  issuesById: ReadonlyMap<string, IssueDragLookup>
): DragOutcome {
  const { source, targetId } = completion;

  // 1. Drag kind dispatch — only `issue-move` is implemented today.
  //    Future kinds (`column-reorder`, `project-reorder`) return invalid
  //    until their resolver branches land.
  if (source.kind !== 'issue-move') {
    return { type: 'invalid', reason: 'unsupported drag kind' };
  }

  // 2. Issue lookup (typed-narrowed via the dispatch above).
  const issueSource = source as Extract<DragSource, { kind: 'issue-move' }>;

  // 3. No active project (e.g. landing page).
  if (!activeProjectId) {
    return { type: 'invalid', reason: 'no active project' };
  }

  // 4. Issue must be present in the lookup.
  const issue = issuesById.get(issueSource.issueId);
  if (!issue) {
    return { type: 'invalid', reason: 'unknown issue' };
  }

  // 5. Active-project guard.
  if (issue.project_id !== activeProjectId) {
    return { type: 'invalid', reason: 'cross-project' };
  }

  // 6. Destination must parse as a valid status target.
  const parsedDest = parseTargetId(targetId, activeProjectId, issuesById);
  if ('invalid' in parsedDest) {
    if (parsedDest.invalid === 'cross-project') {
      return { type: 'invalid', reason: 'cross-project' };
    }
    if (parsedDest.invalid === 'not-a-target') {
      return { type: 'invalid', reason: 'not a drop target' };
    }
    return { type: 'invalid', reason: 'not a valid status target' };
  }

  if (
    parsedDest.surface === 'tree-status' &&
    parsedDest.statusId === issue.status_id
  ) {
    return { type: 'no-op' };
  }

  if (parsedDest.surface === 'kanban') {
    return {
      type: 'kanban-internal',
      issueId: issue.id,
      fromStatusId: issue.status_id,
      toStatusId: parsedDest.statusId,
      projectId: activeProjectId,
      destIndex: completion.index ?? undefined,
    };
  }

  // 9. Tree-status target → cross-surface move.
  return {
    type: 'move-issue',
    issueId: issue.id,
    targetStatusId: parsedDest.statusId,
    projectId: parsedDest.projectId,
  };
}

// Re-export the placement type so callers that don't already import the
// dnd module can still reference the surface explicitly.
export type { Placement };
