import { describe, expect, it } from 'vitest';
import type { DropResult } from '@hello-pangea/dnd';
import { resolveDragEnd } from './resolveDragEnd';

const ACTIVE = 'project-A';
const OTHER_PROJECT = 'project-B';

function uuid(n: number): string {
  // Deterministic UUIDs for fixtures — real UUIDs are unique; we only need
  // distinct, UUID-shaped strings that the parser can match.
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// Project statuses — distinct UUIDs scoped to ACTIVE (the project from
// which the drag originates). Use these in fixtures so kanban column
// droppableIds stay UUID-shaped (the parser requires the canonical form).
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

function makeResult(
  draggableId: string,
  source: { droppableId: string; index: number },
  destination: { droppableId: string; index: number } | null
): DropResult {
  return {
    draggableId,
    type: 'DEFAULT',
    source,
    destination,
    reason: 'DROP',
    mode: 'FLUID',
  };
}

describe('resolveDragEnd', () => {
  it('returns no-op when destination is null (dropped outside any droppable)', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 },
      null
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({ type: 'no-op' });
  });

  it('returns invalid "no active project" when activeProjectId is null', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, null, issues)).toEqual({
      type: 'invalid',
      reason: 'no active project',
    });
  });

  it('returns invalid "not an issue" when draggableId lacks the issue: prefix', () => {
    const result = makeResult(
      COL_TODO, // not an issue, just a bare UUID
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 1 }
    );
    const issues = issuesById();

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not an issue',
    });
  });

  it('returns invalid "not an issue" when draggableId is empty', () => {
    const result = makeResult(
      '',
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 0 }
    );
    expect(resolveDragEnd(result, ACTIVE, issuesById())).toEqual({
      type: 'invalid',
      reason: 'not an issue',
    });
  });

  it('returns invalid "not an issue" when draggableId is "issue:" with no payload', () => {
    const result = makeResult(
      'issue:',
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 0 }
    );
    expect(resolveDragEnd(result, ACTIVE, issuesById())).toEqual({
      type: 'invalid',
      reason: 'not an issue',
    });
  });

  it('returns invalid "unknown issue" when issue is not present in issuesById', () => {
    const result = makeResult(
      'issue:' + uuid(99),
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 0 }
    );
    expect(resolveDragEnd(result, ACTIVE, issuesById())).toEqual({
      type: 'invalid',
      reason: 'unknown issue',
    });
  });

  it('returns invalid "cross-project" when issue.project_id != activeProjectId', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_TODO, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: OTHER_PROJECT,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'cross-project',
    });
  });

  it('returns no-op when source droppable == destination droppable AND same index (kanban column)', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 2 },
      { droppableId: COL_TODO, index: 2 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({ type: 'no-op' });
  });

  it('returns no-op when destination status equals the issue current status (tree card → tree status with same id)', () => {
    // The custom tree drag manager may resolve a drop onto the status row
    // the issue already lives under (magnetic snap-back, sloppy drop); the
    // move would be a no-op write, so collapse it here. Covers the custom
    // path AND the kanban→tree path (both flow through resolveDragEnd).
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 }, // tree card source
      { droppableId: `${ACTIVE}:status:${COL_TODO}`, index: 0 } // same status
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({ type: 'no-op' });
  });

  it('returns kanban-internal for same-status kanban move (guard does NOT fire — kanban reorder path wins)', () => {
    // Regression for guard placement: same-status moves between two kanban
    // columns still surface as kanban-internal so the kanban handler can
    // update sort_order. The guard is intentionally scoped to the move-issue
    // return so manual-sort reorders aren\'t blocked.
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_DONE, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_DONE,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'kanban-internal',
      result,
    });
  });

  it('returns kanban-internal for same-column reorder (diff index within a kanban column)', () => {
    // The kanban handler decides whether to honour the reorder based on
    // kanbanFilters.sortField; resolveDragEnd surfaces it as kanban-internal.
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 2 },
      { droppableId: COL_TODO, index: 5 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'kanban-internal',
      result,
    });
  });

  it('returns kanban-internal for cross-status kanban move', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 },
      { droppableId: COL_DONE, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues).type).toBe('kanban-internal');
  });

  it('returns move-issue when dragging a tree card to a kanban column (diff status)', () => {
    // Tree card droppable id = bare issue UUID (the per-card droppable added
    // by the cross-surface step); the resolver parses it via issuesById.
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 }, // card from tree
      { droppableId: COL_DONE, index: 0 } // kanban column
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_DONE,
      projectId: ACTIVE,
    });
  });

  it('returns move-issue when dragging a kanban card onto another tree card (target = destination card status)', () => {
    // destination.droppableId = another card's UUID → resolver looks up the
    // destination card to learn its target status (uuid(2) sits in COL_DONE).
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: COL_TODO, index: 0 }, // kanban card source
      { droppableId: uuid(2), index: 0 } // tree card destination
    );
    const issues = issuesById(
      {
        id: uuid(1),
        project_id: ACTIVE,
        status_id: COL_TODO,
      },
      {
        id: uuid(2),
        project_id: ACTIVE,
        status_id: COL_DONE,
      }
    );

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_DONE,
      projectId: ACTIVE,
    });
  });

  it('returns move-issue when dragging a tree card to a tree status row', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 }, // card from tree
      { droppableId: `${ACTIVE}:status:${COL_DONE}`, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_DONE,
      projectId: ACTIVE,
    });
  });

  it('returns move-issue when dragging within the tree between two different statuses', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 }, // tree card source
      { droppableId: `${ACTIVE}:status:${COL_REVIEWED}`, index: 0 } // tree status dest
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'move-issue',
      issueId: uuid(1),
      targetStatusId: COL_REVIEWED,
      projectId: ACTIVE,
    });
  });

  it('returns invalid "cross-project" when destination tree-status id has the wrong project prefix', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: `${OTHER_PROJECT}:status:${COL_DONE}`, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'cross-project',
    });
  });

  it('returns invalid "cross-project" when destination tree-card sits in another project', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: uuid(2), index: 0 } // uuid(2) belongs to OTHER_PROJECT
    );
    const issues = issuesById(
      {
        id: uuid(1),
        project_id: ACTIVE,
        status_id: COL_TODO,
      },
      {
        id: uuid(2),
        project_id: OTHER_PROJECT,
        status_id: COL_DONE,
      }
    );

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'cross-project',
    });
  });

  it('returns invalid "not a valid status target" when destination is a workspaces section id', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: `${ACTIVE}:workspaces`, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when destination is a leaf node id', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: 'workspace-42', index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when destination is a project node id', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: ACTIVE, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when destination is a tasks section id', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: `${ACTIVE}:tasks`, index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when destination is an empty string', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: '', index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });

  it('returns invalid "not a valid status target" when destination is a bare word (not a UUID)', () => {
    const result = makeResult(
      'issue:' + uuid(1),
      { droppableId: uuid(1), index: 0 },
      { droppableId: 'some-arbitrary-string', index: 0 }
    );
    const issues = issuesById({
      id: uuid(1),
      project_id: ACTIVE,
      status_id: COL_TODO,
    });

    expect(resolveDragEnd(result, ACTIVE, issues)).toEqual({
      type: 'invalid',
      reason: 'not a valid status target',
    });
  });
});
