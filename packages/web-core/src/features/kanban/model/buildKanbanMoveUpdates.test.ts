import { describe, expect, it } from 'vitest';
import { buildKanbanMoveUpdates } from './buildKanbanMoveUpdates';
import type { KanbanMove } from './kanbanMove';

const STEP = 1000;
const calculateSortOrder = (statusId: string, index: number) => {
  // Mirror KanbanContainer's helper: 1000 * columnIndex + index.
  // status ids here are 'A' and 'B'; map A→1, B→2.
  const columnIndex = statusId === 'A' ? 1 : 2;
  return STEP * columnIndex + (index + 1);
};
const statusColumnIndexMap = new Map<string, number>([
  ['A', 1],
  ['B', 2],
]);

describe('buildKanbanMoveUpdates', () => {
  it('manual sort: writes status_id + sort_order for every dest card and reindexes source column', () => {
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'B',
      index: 1,
    };
    const newItems = {
      A: ['i2', 'i3'],
      B: ['i4', 'i1', 'i5'],
    };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: true,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    // Dest: i4, i1, i5 → sort_orders 2001, 2002, 2003 (column B index 2).
    expect(updates).toEqual([
      { id: 'i4', changes: { status_id: 'B', sort_order: 2001 } },
      { id: 'i1', changes: { status_id: 'B', sort_order: 2002 } },
      { id: 'i5', changes: { status_id: 'B', sort_order: 2003 } },
      // Source: i2, i3 → sort_orders 1001, 1002 (column A index 1).
      { id: 'i2', changes: { sort_order: 1001 } },
      { id: 'i3', changes: { sort_order: 1002 } },
    ]);
  });

  it('non-manual sort: writes ONLY status_id for the moved card (no dest reindex, no source reindex)', () => {
    // P4-B1: under non-manual sort, the index is dropped (the move
    // APPENDS — see computeKanbanMove with index: undefined) and the
    // sort_order rewrite is meaningless. The next shape sync re-derives
    // order from the active sort field.
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'B',
      index: 2,
    };
    const newItems = {
      A: ['i2', 'i3'],
      B: ['i4', 'i1', 'i5'],
    };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: false,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    expect(updates).toEqual([{ id: 'i1', changes: { status_id: 'B' } }]);
  });

  it('non-manual sort: still cleans the source column locally (computeKanbanMove removes the card), but no sort_order writes', () => {
    // The caller invokes `computeKanbanMove(prev, index-less move)` to
    // derive `newItems`. We don't touch that here — the helper just
    // decides WHAT to persist. Verify the helper produces ZERO source
    // updates regardless of whether the source column shrank.
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'B',
    };
    const newItems = {
      A: ['i2', 'i3'], // i1 removed
      B: ['i4', 'i5', 'i1'], // i1 appended
    };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: false,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    // Only the move card's status update, none for i2/i3/i4/i5.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ id: 'i1', changes: { status_id: 'B' } });
  });

  it('non-manual sort: same-status drop still produces a single status_id update when status differs via no-op', () => {
    // The component short-circuits same-status drops in the calling
    // code path, but the helper itself is still well-defined for a
    // cross-status move whose dest column is empty.
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'B',
    };
    const newItems = { A: [], B: ['i1'] };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: false,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    expect(updates).toEqual([{ id: 'i1', changes: { status_id: 'B' } }]);
  });

  it('manual sort: when source status is not in statusColumnIndexMap, source reindex is skipped', () => {
    // Defensive: a stale source column (e.g. a status deleted in the
    // intervening shape sync) must not generate source-column updates.
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'DELETED',
      toStatusId: 'B',
      index: 0,
    };
    const newItems = {
      DELETED: ['i2'],
      B: ['i1'],
    };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: true,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    // Only the dest-side updates; no source reindex.
    expect(updates).toEqual([
      { id: 'i1', changes: { status_id: 'B', sort_order: 2001 } },
    ]);
  });

  it('manual sort: same-column reorder produces no source reindex (from === to)', () => {
    // The list-view adapter calls handleKanbanMove with from === to and
    // an explicit index. The source reindex must be skipped so we don't
    // rewrite every card's sort_order for a no-op.
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'A',
      index: 1,
    };
    const newItems = {
      A: ['i2', 'i1', 'i3'],
    };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: true,
      calculateSortOrder,
      statusColumnIndexMap,
    });
    expect(updates).toEqual([
      { id: 'i2', changes: { status_id: 'A', sort_order: 1001 } },
      { id: 'i1', changes: { status_id: 'A', sort_order: 1002 } },
      { id: 'i3', changes: { status_id: 'A', sort_order: 1003 } },
    ]);
  });

  it('manual sort: writes sort_order based on the column map, not a fixed formula', () => {
    // The helper honours whatever `calculateSortOrder` returns. Verify
    // the test-side stub is what the helper sees (the component owns
    // the real formula).
    const customCalc = (statusId: string, index: number) => index * 7;
    const move: KanbanMove = {
      issueId: 'i1',
      fromStatusId: 'A',
      toStatusId: 'B',
      index: 0,
    };
    const newItems = { A: [], B: ['i1', 'i2'] };
    const updates = buildKanbanMoveUpdates({
      newItems,
      move,
      isManualSort: true,
      calculateSortOrder: customCalc,
      statusColumnIndexMap,
    });
    expect(updates).toEqual([
      { id: 'i1', changes: { status_id: 'B', sort_order: 0 } },
      { id: 'i2', changes: { status_id: 'B', sort_order: 7 } },
    ]);
  });
});
