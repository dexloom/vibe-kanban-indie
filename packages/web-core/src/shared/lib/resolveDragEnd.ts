import type { DragCompletion, Placement } from '@vibe/ui/components/dnd';
import { UNASSIGNED_PROJECT_ID } from '@vibe/ui/components/outliner/types';
import { parseTargetId } from './targetId';

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
  sort_order: number;
}

export type DragOutcome =
  | { type: 'no-op' }
  | {
      type: 'kanban-internal';
      issueId: string;
      fromStatusId: string;
      toStatusId: string;
      projectId: string;
      /** Insertion slot in the destination column, or null to append. */
      index: number | null;
    }
  | {
      type: 'issue-swap';
      sourceIssueId: string;
      targetIssueId: string;
      projectId: string;
    }
  | {
      type: 'move-issue';
      issueId: string;
      targetStatusId: string;
      projectId: string;
    }
  | { type: 'project-reorder'; projectId: string; targetProjectId: string }
  | { type: 'invalid'; reason: string };

/**
 * Resolve a `DragCompletion` (the unified custom drag system's drop
 * payload) into one of six outcomes:
 *
 *  - `no-op`            — nothing meaningful changed (drag kind unsupported,
 *                         same-status drop, no destination, project-reorder
 *                         onto self / unassigned, or an issue-swap onto
 *                         self).
 *  - `kanban-internal`  — destination is a bare-UUID kanban column (NOT a
 *                         known issue); delegate to the kanban board's
 *                         existing handler.
 *  - `issue-swap`       — destination is a known issue in the same project;
 *                         the layout swaps the two issues' `status_id`.
 *  - `move-issue`       — destination is a tree-status row OR a kanban column
 *                         AND the source is an issue-move; the layout fires
 *                         `bulkUpdateIssues` with the resolved target status.
 *  - `project-reorder`  — source is project-reorder; layout swaps project
 *                         positions and writes `sort_order` for the full
 *                         ordered list via `bulkUpdateProjects`.
 *  - `invalid`          — reason is logged and the drop is silently snapped
 *                         back.
 *
 * The function is pure: callers supply `activeProjectId`, `issuesById`,
 * and `statusIds` (the active project's visible status-id set — used to
 * reject stale `data-drop-target-id` attrs pointing at deleted statuses).
 */
export function resolveDragEnd(
  completion: DragCompletion,
  activeProjectId: string | null,
  issuesById: ReadonlyMap<string, IssueDragLookup>,
  statusIds: ReadonlySet<string>
): DragOutcome {
  const { source, targetId } = completion;

  // 1a. Project reorder branch — SWAP semantics, runs ahead of the
  //     issue-move path so same-id or unassigned targets surface as
  //     no-ops rather than invalid. `placement`, `index`, `issuesById`,
  //     `statusIds`, and `activeProjectId` are unused for this branch
  //     (signature unchanged).
  if (source.kind === 'project-reorder') {
    const targetProjectId = targetId;
    if (targetProjectId === source.projectId) return { type: 'no-op' };
    if (targetProjectId === UNASSIGNED_PROJECT_ID) return { type: 'no-op' };
    return {
      type: 'project-reorder',
      projectId: source.projectId,
      targetProjectId,
    };
  }

  // 1. Drag kind dispatch — `issue-move` is the only remaining branch
  //    today; any future kind that slips through returns invalid.
  if (source.kind !== 'issue-move') {
    return { type: 'invalid', reason: 'unsupported drag kind' };
  }

  // 2. No active project (e.g. landing page).
  if (!activeProjectId) {
    return { type: 'invalid', reason: 'no active project' };
  }

  // 3. Issue must be present in the lookup.
  const issue = issuesById.get(source.issueId);
  if (!issue) {
    return { type: 'invalid', reason: 'unknown issue' };
  }

  // 4. Active-project guard.
  if (issue.project_id !== activeProjectId) {
    return { type: 'invalid', reason: 'cross-project' };
  }

  // 5. Self-swap is a no-op (defensive — the controller already excludes
  //    the dragged card from collected targets).
  if (targetId === source.issueId) {
    return { type: 'no-op' };
  }

  // 6. Card target = a known issue in the same project. SWAP the two
  //    issues' status_id fields. The target issue must belong to the
  //    active project (cross-project swap is invalid).
  const targetIssue = issuesById.get(targetId);
  if (targetIssue) {
    if (targetIssue.project_id !== activeProjectId) {
      return { type: 'invalid', reason: 'cross-project' };
    }
    return {
      type: 'issue-swap',
      sourceIssueId: source.issueId,
      targetIssueId: targetIssue.id,
      projectId: activeProjectId,
    };
  }

  // 7. Destination must parse as a valid status target.
  const parsedDest = parseTargetId(targetId, (id) => issuesById.has(id));
  if (!parsedDest) {
    return { type: 'invalid', reason: 'not a valid status target' };
  }

  // 8. Tree-status cross-project guard (parseTargetId doesn't carry the
  //    active project; we layer it on here).
  if (
    parsedDest.surface === 'tree-status' &&
    parsedDest.projectId !== activeProjectId
  ) {
    return { type: 'invalid', reason: 'cross-project' };
  }

  // 9. Reject stale `data-drop-target-id` attrs pointing at a deleted
  //    status (the kanban column was removed but the DOM attr still
  //    references the old UUID). Without this guard the resolver would
  //    happily route the move into a status_id that no longer exists.
  if (parsedDest.surface === 'kanban' && !statusIds.has(parsedDest.statusId)) {
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
      index: completion.index ?? null,
    };
  }

  // Tree-status target → cross-surface move.
  return {
    type: 'move-issue',
    issueId: issue.id,
    targetStatusId: parsedDest.statusId,
    projectId: parsedDest.projectId!,
  };
}

// Re-export the placement type so callers that don't already import the
// dnd module can still reference the surface explicitly.
export type { Placement };
