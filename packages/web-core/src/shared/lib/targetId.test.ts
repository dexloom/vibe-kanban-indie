import { describe, expect, it } from 'vitest';
import {
  TREE_STATUS_PATTERN,
  isTreeStatusTarget,
  parseTargetId,
} from './targetId';
import { SHARED_TARGET_ID_FIXTURE } from '../../../../ui/src/components/dnd/targetKind.fixture';

describe('TREE_STATUS_PATTERN', () => {
  it('matches <projectId>:status:<statusId>', () => {
    const match = TREE_STATUS_PATTERN.exec('project-1:status:todo');
    expect(match?.[1]).toBe('project-1');
    expect(match?.[2]).toBe('todo');
  });

  it('does not match a bare UUID', () => {
    expect(
      TREE_STATUS_PATTERN.exec('11111111-1111-4111-8111-111111111111')
    ).toBeNull();
  });

  it('does not match a non-status colon segment (e.g. :tasks, :workspaces)', () => {
    expect(TREE_STATUS_PATTERN.exec('project-1:tasks')).toBeNull();
    expect(TREE_STATUS_PATTERN.exec('project-1:workspaces')).toBeNull();
  });
});

describe('isTreeStatusTarget', () => {
  it('returns true for tree-status targets', () => {
    expect(isTreeStatusTarget('project-1:status:todo')).toBe(true);
  });

  it('returns false for kanban-column (UUID) targets', () => {
    expect(isTreeStatusTarget('11111111-1111-4111-8111-111111111111')).toBe(
      false
    );
  });

  it('returns false for non-status colon segments', () => {
    expect(isTreeStatusTarget('project-1:tasks')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isTreeStatusTarget('')).toBe(false);
  });
});

describe('parseTargetId', () => {
  it('parses a tree-status target', () => {
    expect(parseTargetId('project-1:status:todo', () => false)).toEqual({
      surface: 'tree-status',
      statusId: 'todo',
      projectId: 'project-1',
    });
  });

  it('classifies a bare UUID that is NOT a known issue as a kanban surface', () => {
    expect(
      parseTargetId('11111111-1111-4111-8111-111111111111', () => false)
    ).toEqual({
      surface: 'kanban',
      statusId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('rejects a bare UUID that matches a known issue (cards are not drop targets)', () => {
    const knownIssueId = '11111111-1111-4111-8111-111111111111';
    expect(parseTargetId(knownIssueId, (id) => id === knownIssueId)).toBeNull();
  });

  it('returns null for non-status colon segments', () => {
    expect(parseTargetId('project-1:tasks', () => false)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseTargetId('', () => false)).toBeNull();
  });
});

describe('target-grammar sync (cross-package)', () => {
  // Re-implements `isColumnLikeTarget` from `packages/ui/src/components/dnd/targetKind.ts`
  // — production code can't import across the package boundary (ui cannot
  // import web-core and vice versa), but tests can. This is the
  // tripwire: if either side drifts, this assertion fires in the package
  // whose suite ran first. The companion test in `targetKind.test.ts`
  // covers the other direction.
  function isColumnLikeTarget(id: string): boolean {
    return !/^([^:]+):status:(.+)$/.test(id);
  }

  it('keeps web-core isTreeStatusTarget and ui mirror isColumnLikeTarget complementary on every fixture id', () => {
    for (const id of SHARED_TARGET_ID_FIXTURE) {
      expect(isTreeStatusTarget(id)).toBe(!isColumnLikeTarget(id));
    }
  });
});
