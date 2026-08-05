import { describe, expect, it } from 'vitest';
import {
  TREE_STATUS_PATTERN,
  isTreeStatusTarget,
  parseTargetId,
} from './targetId';
import { SHARED_TARGET_ID_FIXTURE } from '../../../../ui/src/components/dnd/targetKind.fixture';
import { isColumnLikeTarget } from '@vibe/ui/components/dnd';

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
  // The web-core test imports the REAL `isColumnLikeTarget` from ui (the
  // export was added to `packages/ui/src/components/dnd/index.ts`). Both
  // layers' predicates must agree on every fixture id — if either side
  // drifts, this assertion fires in the package whose suite ran first.
  // The companion test in `targetKind.test.ts` covers the other direction
  // with the mirror re-implementation (ui cannot import web-core).
  it('keeps web-core isTreeStatusTarget and ui mirror isColumnLikeTarget complementary on every fixture id', () => {
    for (const id of SHARED_TARGET_ID_FIXTURE) {
      expect(isTreeStatusTarget(id)).toBe(!isColumnLikeTarget(id));
    }
  });

  // The reverse direction: explicit cross-package agreement on the
  // individual cases the layer rule cares about, asserted against the
  // REAL ui export (no shadow re-implementation).
  it('imports isColumnLikeTarget from ui and agrees with web-core grammar on canonical cases', () => {
    expect(isColumnLikeTarget('11111111-1111-4111-8111-111111111111')).toBe(
      true
    );
    expect(isTreeStatusTarget('11111111-1111-4111-8111-111111111111')).toBe(
      false
    );
    expect(isColumnLikeTarget('project-1:status:todo')).toBe(false);
    expect(isTreeStatusTarget('project-1:status:todo')).toBe(true);
    expect(isColumnLikeTarget('project-1:status:sub')).toBe(false);
    expect(isTreeStatusTarget('project-1:status:sub')).toBe(true);
  });
});
