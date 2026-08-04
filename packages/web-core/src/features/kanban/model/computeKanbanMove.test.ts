import { describe, expect, it } from 'vitest';
import { computeKanbanMove } from './computeKanbanMove';
import type { KanbanMove } from './kanbanMove';

function items(
  ...columns: Array<[string, string[]]>
): Record<string, string[]> {
  return Object.fromEntries(columns);
}

describe('computeKanbanMove', () => {
  it('moves a card between columns (appends to destination)', () => {
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

  it('appends to an empty destination column', () => {
    const move: KanbanMove = {
      issueId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'done',
    };
    const result = computeKanbanMove(
      items(['todo', ['a', 'b']], ['done', []]),
      move
    );
    expect(result.todo).toEqual(['b']);
    expect(result.done).toEqual(['a']);
  });

  it('returns the input unchanged for a same-status move (no-op)', () => {
    const move: KanbanMove = {
      issueId: 'a',
      fromStatusId: 'todo',
      toStatusId: 'todo',
    };
    const prev = items(['todo', ['a', 'b', 'c']]);
    const result = computeKanbanMove(prev, move);
    expect(result).toBe(prev);
    expect(result.todo).toEqual(['a', 'b', 'c']);
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
