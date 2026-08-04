import { describe, expect, it } from 'vitest';
import type { DragCompletion } from '@vibe/ui/components/dnd';
import { UNASSIGNED_PROJECT_ID } from '@vibe/ui/components/outliner/types';
import { resolveDragEnd } from './resolveDragEnd';

const ACTIVE = 'project-A';
const OTHER_PROJECT = 'project-B';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const COL_TODO = uuid(10);
const COL_DONE = uuid(11);
const COL_REVIEWED = uuid(12);
const COL_DELETED = uuid(99);

interface IssueFixture {
  id: string;
  project_id: string;
  status_id: string;
}

function issuesById(...list: IssueFixture[]): Map<string, IssueFixture> {
  return new Map(list.map((i) => [i.id, i] as const));
}

function statusIdsOf(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

const ACTIVE_STATUS_IDS = statusIdsOf(COL_TODO, COL_DONE, COL_REVIEWED);

function makeCompletion(
  sourceId: string,
  targetId: string,
  projectId: string = ACTIVE,
  index: number | null = null,
  kind: 'issue-move' | 'project-reorder' = 'issue-move'
): DragCompletion {
  if (kind === 'project-reorder') {
    return {
      source: { kind: 'project-reorder', projectId: sourceId },
      targetId,
      placement: 'on',
      index,
    };
  }
  return {
    source: { kind: 'issue-move', issueId: sourceId, projectId },
    targetId,
    placement: 'on',
    index,
  };
}

describe('resolveDragEnd', () => {
  it('returns invalid "unsupported drag kind" when the source kind is not issue-move', () => {
    const completion = {
      // Cast to bypass the type system; mirrors how a future reorder
      // kind would dispatch before its branch land.
      source: { kind: 'column-reorder', columnId: 'x', projectId: ACTIVE },
      targetId: COL_TODO,
      placement: 'on' as const,
    } as unknown as DragCompletion;
    expect(
      resolveDragEnd(completion, ACTIVE, issuesById(), ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'unsupported drag kind',
    });
  });

  it('returns invalid "no active project" when activeProjectId is null', () => {
    const completion = makeCompletion(uuid(1), COL_TODO);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(resolveDragEnd(completion, null, issues, ACTIVE_STATUS_IDS)).toEqual(
      {
        type: 'invalid',
        reason: 'no active project',
      }
    );
  });

  it('returns invalid "unknown issue" when the issue is not in issuesById', () => {
    const completion = makeCompletion(uuid(99), COL_TODO);
    expect(
      resolveDragEnd(completion, ACTIVE, issuesById(), ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'unknown issue',
    });
  });

  it('returns invalid "cross-project" when issue.project_id != activeProjectId', () => {
    const completion = makeCompletion(uuid(1), COL_TODO);
    const issues = issuesById({
      id: uuid(1),
      project_id: OTHER_PROJECT,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'cross-project',
    });
  });

  it('routes same-status kanban drops to kanban handler', () => {
    const completion = makeCompletion(uuid(1), COL_TODO);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'kanban-internal',
      issueId: uuid(1),
      fromStatusId: COL_TODO,
      toStatusId: COL_TODO,
      projectId: ACTIVE,
      destIndex: undefined,
    });
  });

  it('returns no-op when destination status equals the issue current status (tree-status)', () => {
    const completion = makeCompletion(uuid(1), `${ACTIVE}:status:${COL_TODO}`);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'no-op',
    });
  });

  it('returns kanban-internal for cross-status kanban move', () => {
    const completion = makeCompletion(uuid(1), COL_DONE);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'kanban-internal',
      issueId: uuid(1),
      fromStatusId: COL_TODO,
      toStatusId: COL_DONE,
      projectId: ACTIVE,
    });
  });

  it('returns move-issue when dragging a tree card to a tree status row', () => {
    const completion = makeCompletion(uuid(1), `${ACTIVE}:status:${COL_DONE}`);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_DONE,
      projectId: ACTIVE,
    });
  });

  it('returns move-issue when dragging a kanban card onto a tree status row', () => {
    const completion = makeCompletion(
      uuid(1),
      `${ACTIVE}:status:${COL_REVIEWED}`
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_REVIEWED,
      projectId: ACTIVE,
    });
  });

  it('returns invalid "cross-project" when tree-status target has the wrong project prefix', () => {
    const completion = makeCompletion(
      uuid(1),
      `${OTHER_PROJECT}:status:${COL_DONE}`
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'cross-project',
    });
  });

  it('returns invalid "not a drop target" when targetId resolves to a known issue (cards are no longer drop targets)', () => {
    const completion = makeCompletion(uuid(1), uuid(2));
    const issues = issuesById(
      { id: uuid(1), project_id: ACTIVE, status_id: COL_TODO },
      { id: uuid(2), project_id: ACTIVE, status_id: COL_DONE }
    );
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" for a workspaces section id', () => {
    const completion = makeCompletion(uuid(1), `${ACTIVE}:workspaces`);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when targetId is a leaf node id', () => {
    const completion = makeCompletion(uuid(1), 'workspace-42');
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when targetId is a project id', () => {
    const completion = makeCompletion(uuid(1), ACTIVE);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when targetId is a tasks section id', () => {
    const completion = makeCompletion(uuid(1), `${ACTIVE}:tasks`);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when targetId is empty', () => {
    const completion = makeCompletion(uuid(1), '');
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when targetId is a bare word (not a UUID)', () => {
    const completion = makeCompletion(uuid(1), 'some-arbitrary-string');
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('passes through the resolved destIndex on a kanban-internal completion', () => {
    const completion = makeCompletion(uuid(1), COL_DONE, ACTIVE, 2);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'kanban-internal',
      issueId: uuid(1),
      fromStatusId: COL_TODO,
      toStatusId: COL_DONE,
      projectId: ACTIVE,
      destIndex: 2,
    });
  });

  it('always carries destIndex on the kanban-internal outcome (undefined when the completion has no index)', () => {
    const completion = makeCompletion(uuid(1), COL_DONE, ACTIVE, null);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    const outcome = resolveDragEnd(
      completion,
      ACTIVE,
      issues,
      ACTIVE_STATUS_IDS
    );
    expect(outcome).toEqual({
      type: 'kanban-internal',
      issueId: uuid(1),
      fromStatusId: COL_TODO,
      toStatusId: COL_DONE,
      projectId: ACTIVE,
      destIndex: undefined,
    });
  });

  it('returns invalid "not a valid status target" when a UUID target is NOT in the active status set (stale data-drop-target-id after a status deletion)', () => {
    const completion = makeCompletion(uuid(1), COL_DELETED);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    // ACTIVE_STATUS_IDS does not include COL_DELETED → the kanban column
    // references a status that was removed; refuse to route the move.
    expect(
      resolveDragEnd(completion, ACTIVE, issues, ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  // -----------------------------------------------------------------------
  // project-reorder branch (SWAP semantics). The branch runs BEFORE the
  // issue-move path so self-targeting and unassigned-target drops surface
  // as no-op rather than invalid. `placement`/`index`/`issuesById`/
  // `statusIds`/`activeProjectId` are unused for this kind.
  // -----------------------------------------------------------------------
  const PROJECT_A = 'project-A-uuid';
  const PROJECT_B = 'project-B-uuid';

  it('returns project-reorder when dragging project A onto project B (swap semantics)', () => {
    const completion = makeCompletion(
      PROJECT_A,
      PROJECT_B,
      ACTIVE,
      null,
      'project-reorder'
    );
    expect(
      resolveDragEnd(completion, null, issuesById(), ACTIVE_STATUS_IDS)
    ).toEqual({
      type: 'project-reorder',
      projectId: PROJECT_A,
      targetProjectId: PROJECT_B,
    });
  });

  it('returns no-op when target === source (project-reorder onto self)', () => {
    const completion = makeCompletion(
      PROJECT_A,
      PROJECT_A,
      ACTIVE,
      null,
      'project-reorder'
    );
    expect(
      resolveDragEnd(completion, null, issuesById(), ACTIVE_STATUS_IDS)
    ).toEqual({ type: 'no-op' });
  });

  it('returns no-op when target is UNASSIGNED_PROJECT_ID (project-reorder onto unassigned)', () => {
    const completion = makeCompletion(
      PROJECT_A,
      UNASSIGNED_PROJECT_ID,
      ACTIVE,
      null,
      'project-reorder'
    );
    expect(
      resolveDragEnd(completion, null, issuesById(), ACTIVE_STATUS_IDS)
    ).toEqual({ type: 'no-op' });
  });

  it('does NOT route project-reorder through issue-move logic (empty issues/statusIds preserved)', () => {
    // The project-reorder branch returns without touching issuesById /
    // statusIds / activeProjectId. Passing empties that would fail the
    // issue-move guards must NOT be rejected — the branch executes first.
    const completion = makeCompletion(
      PROJECT_A,
      PROJECT_B,
      ACTIVE,
      null,
      'project-reorder'
    );
    const outcome = resolveDragEnd(completion, null, new Map(), new Set());
    expect(outcome).toEqual({
      type: 'project-reorder',
      projectId: PROJECT_A,
      targetProjectId: PROJECT_B,
    });
  });
});
