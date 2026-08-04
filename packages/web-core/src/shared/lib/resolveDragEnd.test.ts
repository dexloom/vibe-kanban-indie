import { describe, expect, it } from 'vitest';
import type { DragCompletion } from '@vibe/ui/components/dnd';
import { resolveDragEnd } from './resolveDragEnd';

const ACTIVE = 'project-A';
const OTHER_PROJECT = 'project-B';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

const COL_TODO = uuid(10);
const COL_DONE = uuid(11);
const COL_REVIEWED = uuid(12);

interface IssueFixture {
  id: string;
  project_id: string;
  status_id: string;
}

function issuesById(...list: IssueFixture[]): Map<string, IssueFixture> {
  return new Map(list.map((i) => [i.id, i] as const));
}

function makeCompletion(
  issueId: string,
  targetId: string,
  projectId = ACTIVE
): DragCompletion {
  return {
    source: { kind: 'issue-move', issueId, projectId },
    targetId,
    placement: 'on',
    index: null,
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
    expect(resolveDragEnd(completion, ACTIVE, issuesById())).toEqual({
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
    expect(resolveDragEnd(completion, null, issues)).toEqual({
      type: 'invalid',
      reason: 'no active project',
    });
  });

  it('returns invalid "unknown issue" when the issue is not in issuesById', () => {
    const completion = makeCompletion(uuid(99), COL_TODO);
    expect(resolveDragEnd(completion, ACTIVE, issuesById())).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a drop target',
    });
  });

  it('returns invalid "not a valid status target" for a workspaces section id', () => {
    const completion = makeCompletion(uuid(1), `${ACTIVE}:workspaces`);
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
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
    expect(resolveDragEnd(completion, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });
});
