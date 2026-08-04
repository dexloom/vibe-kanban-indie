import { describe, expect, it } from 'vitest';
import { computeKanbanMove } from './computeKanbanMove';
import type { KanbanMove } from './kanbanMove';

function items(
  ...columns: Array<[string, string[]]>
): Record<string, string[]> {
  return Object.fromEntries(columns);
}

describe('computeKanbanMove', () => {
  it('moves a card between columns', () => {
    const move: KanbanMove = {
      issueId: 'b',
      fromStatusId: 'todo',
      toStatusId: 'done',
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b', 'c']], ['done', ['x']]),
      move
    );
    expect(result).toEqual({
      todo: ['a', 'c'],
      done: ['x', 'b'],
    });
  });

  it('appends to the destination column when destIndex is undefined', () => {
    const move: KanbanMove = {
      issueId: 'b',
      fromStatusId: 'todo',
      toStatusId: 'done',
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', ['x', 'y']]),
      move
    );
    expect(result.done).toEqual(['x', 'y', 'b']);
  });

  it('inserts at the given destIndex inside the destination column', () => {
    const move: KanbanMove = {
      issueId: 'b',
      fromStatusId: 'todo',
      toStatusId: 'done',
      destIndex: 1,
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', ['x', 'y', 'z']]),
      move
    );
    expect(result.done).toEqual(['x', 'b', 'y', 'z']);
  });

  it('clamps destIndex to the destination length when too large', () => {
    const move: KanbanMove = {
      issueId: 'b',
      fromStatusId: 'todo',
      toStatusId: 'done',
      destIndex: 100,
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', ['x']]),
      move
    );
    expect(result.done).toEqual(['x', 'b']);
  });

  it('clamps a negative destIndex to 0', () => {
    const move: KanbanMove = {
      issueId: 'b',
      fromStatusId: 'todo',
      toStatusId: 'done',
      destIndex: -5,
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', ['x', 'y']]),
      move
    );
    expect(result.done).toEqual(['b', 'x', 'y']);
  });

  it('reorders within a column when fromStatusId === toStatusId', () => {
    const move: KanbanMove = {
      issueId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'todo',
      destIndex: 2,
    };
    const result = computeKanbanMove(items(['todo', ['a', 'b', 'c']]), move);
    expect(result.todo).toEqual(['b', 'c', 'a']);
  });

  it('cross-column move leaves the destination column untouched apart from the appended issue (no defensive filter on dest)', () => {
    // Round-3 #13 regression guard: dest filter is gated on
    // `fromStatusId === toStatusId`. The cross-column path appends
    // directly without touching the destination's existing ids.
    const move: KanbanMove = {
      issueId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'done',
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', ['x', 'y']]),
      move
    );
    expect(result.todo).toEqual(['b']);
    expect(result.done).toEqual(['x', 'y', 'a']);
  });

  it('does not mutate the input map or its arrays', () => {
    const prev = items(['todo', ['a', 'b']], ['done', ['x']]);
    const move: KanbanMove = {
      issueId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'done',
    };
    const result = computeKanbanMove(prev, move);
    expect(prev.todo).toEqual(['a', 'b']);
    expect(prev.done).toEqual(['x']);
    expect(result).not.toBe(prev);
  });
});
