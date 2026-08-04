import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  DROP_THRESHOLD_PX,
  adjustInsertionIndex,
  computePlacement,
  findBestCandidate,
  manhattanDistanceToRect,
  type TargetRect,
  computeInsertIndex,
  type CardRect,
} from './geometry';

function rect(
  droppableId: string,
  left: number,
  top: number,
  right: number,
  bottom: number,
): TargetRect {
  return { droppableId, left, top, right, bottom };
}

describe('computeInsertIndex', () => {
  const cards: CardRect[] = [
    { top: 0, bottom: 10 },
    { top: 20, bottom: 30 },
  ];
  it('returns 0 for empty cards', () =>
    expect(computeInsertIndex(5, [])).toBe(0));
  it('splits single card at midpoint', () => {
    expect(computeInsertIndex(4, [{ top: 0, bottom: 10 }])).toBe(0);
    expect(computeInsertIndex(6, [{ top: 0, bottom: 10 }])).toBe(1);
  });
  it('returns slots across two cards and appends below all', () => {
    expect(computeInsertIndex(-1, cards)).toBe(0);
    expect(computeInsertIndex(15, cards)).toBe(1);
    expect(computeInsertIndex(31, cards)).toBe(2);
    expect(computeInsertIndex(1000, cards)).toBe(cards.length);
  });
});
describe('DRAG_THRESHOLD_PX / DROP_THRESHOLD_PX constants', () => {
  it('exposes the documented promote threshold (5px)', () => {
    expect(DRAG_THRESHOLD_PX).toBe(5);
  });

  it('exposes the documented magnetic radius (32px)', () => {
    expect(DROP_THRESHOLD_PX).toBe(32);
  });
});

describe('manhattanDistanceToRect', () => {
  const r = rect('r1', 10, 20, 30, 40); // width=20, height=20

  it('returns 0 when the point is inside the rect (centre)', () => {
    expect(manhattanDistanceToRect(20, 30, r)).toBe(0);
  });

  it('returns 0 when the point sits on the left edge', () => {
    expect(manhattanDistanceToRect(10, 30, r)).toBe(0);
  });

  it('returns 0 when the point sits on the top edge', () => {
    expect(manhattanDistanceToRect(20, 20, r)).toBe(0);
  });

  it('returns 0 when the point sits on the right edge', () => {
    expect(manhattanDistanceToRect(30, 30, r)).toBe(0);
  });

  it('returns 0 when the point sits on the bottom edge', () => {
    expect(manhattanDistanceToRect(20, 40, r)).toBe(0);
  });

  it('returns dx+dy to the corner when the point is diagonal and outside', () => {
    // (5, 15) → clamp to (10, 20) → dx=5, dy=5 → 10
    expect(manhattanDistanceToRect(5, 15, r)).toBe(10);
  });

  it('returns dx only when the point is directly left of the rect', () => {
    // (0, 30) → clamp to (10, 30) → dx=10, dy=0 → 10
    expect(manhattanDistanceToRect(0, 30, r)).toBe(10);
  });

  it('returns dy only when the point is directly above the rect', () => {
    // (20, 0) → clamp to (20, 20) → dx=0, dy=20 → 20
    expect(manhattanDistanceToRect(20, 0, r)).toBe(20);
  });
});

describe('computePlacement', () => {
  // Target with height 30: top=0, topThird=10, bottomThird=20, bottom=30.
  const r = rect('r1', 0, 0, 10, 30);

  it('returns "before" when the pointer is in the top third', () => {
    expect(computePlacement(5, 5, r)).toBe('before');
  });

  it('returns "before" at the top-third boundary', () => {
    // height/3 = 10; at y===top → before.
    expect(computePlacement(5, 0, r)).toBe('before');
    expect(computePlacement(5, 9, r)).toBe('before');
  });

  it('returns "on" when the pointer sits in the middle third', () => {
    expect(computePlacement(5, 10, r)).toBe('on');
    expect(computePlacement(5, 15, r)).toBe('on');
    expect(computePlacement(5, 19, r)).toBe('on');
  });

  it('returns "after" when the pointer is in the bottom third', () => {
    // Strictly past bottomThird (20) → 'after'.
    expect(computePlacement(5, 21, r)).toBe('after');
    expect(computePlacement(5, 25, r)).toBe('after');
    expect(computePlacement(5, 30, r)).toBe('after');
  });
});

describe('findBestCandidate', () => {
  it('returns null targetId and null placement when the targets array is empty', () => {
    expect(findBestCandidate(0, 0, [], 100)).toEqual({
      targetId: null,
      placement: null,
      index: null,
      sourceIssueId: null,
    });
  });

  it('returns null targetId and null placement when every target is farther than the threshold', () => {
    const targets = [
      rect('far', 1000, 1000, 1100, 1100),
      rect('farther', 2000, 2000, 2100, 2100),
    ];
    expect(findBestCandidate(0, 0, targets, 100)).toEqual({
      targetId: null,
      placement: null,
      index: null,
      sourceIssueId: null,
    });
  });

  it('returns the target containing the pointer (distance 0) with placement "on"', () => {
    const targets = [rect('a', 10, 10, 20, 20), rect('b', 50, 50, 60, 60)];
    const result = findBestCandidate(15, 15, targets, 100);
    expect(result.targetId).toBe('a');
    expect(result.placement).toBe('on');
  });

  it('returns the nearest target when the pointer is outside all targets', () => {
    // (0, 30) → distance to a: 10 (clamp to left edge), distance to b: 30
    const targets = [rect('a', 10, 20, 30, 40), rect('b', 60, 20, 80, 40)];
    const result = findBestCandidate(0, 30, targets, 100);
    expect(result.targetId).toBe('a');
    expect(result.placement).not.toBeNull();
  });

  it('prefers an inside match (distance 0) over a closer outside match', () => {
    // c sits under the pointer; b is 5px away (closer than a's 10px),
    // but inside-distance-0 wins.
    const targets = [
      rect('a', 100, 100, 200, 200), // far outside
      rect('b', 40, 25, 50, 35), // 5px to the left
      rect('c', 10, 20, 30, 40), // contains (30, 30)
    ];
    expect(findBestCandidate(30, 30, targets, 100).targetId).toBe('c');
  });

  it('breaks ties on equal inside-distance by smaller area', () => {
    // Both contain the pointer, equal distance (0). Smaller area wins.
    const targets = [
      rect('big', 0, 0, 1000, 1000),
      rect('small', 10, 10, 30, 30),
    ];
    expect(findBestCandidate(20, 20, targets, 100).targetId).toBe('small');
  });

  it('breaks ties on equal outside-distance by smaller area', () => {
    // Both contain the pointer (distance 0). Smaller area wins.
    const targets = [
      rect('big', 0, 0, 200, 200),
      rect('small', 105, 105, 115, 115),
    ];
    expect(findBestCandidate(110, 110, targets, 100).targetId).toBe('small');
  });

  it('respects the threshold boundary — equal-to-threshold is included', () => {
    // Pointer at (0, 0). Target r1 at (50, 0, 60, 10): distance = 50.
    // Threshold = 50 → distance ≤ threshold → included.
    const targets = [rect('r1', 50, 0, 60, 10)];
    expect(findBestCandidate(0, 0, targets, 50).targetId).toBe('r1');
  });

  it('rejects a target strictly outside the threshold', () => {
    const targets = [rect('r1', 51, 0, 60, 10)];
    expect(findBestCandidate(0, 0, targets, 50).targetId).toBeNull();
  });

  it('returns placement "before" when the pointer is in the top third of the winning target', () => {
    // Target rect: (0, 0, 100, 30). height=30, topThird=10. Pointer at (50, 5)
    // is inside, in the top third → placement "before".
    const targets = [rect('a', 0, 0, 100, 30)];
    const result = findBestCandidate(50, 5, targets, 100);
    expect(result.targetId).toBe('a');
    expect(result.placement).toBe('before');
  });

  it('returns placement "after" when the pointer is in the bottom third of the winning target', () => {
    // Same target: bottom third = 20..30. Pointer at (50, 25) → "after".
    const targets = [rect('a', 0, 0, 100, 30)];
    const result = findBestCandidate(50, 25, targets, 100);
    expect(result.targetId).toBe('a');
    expect(result.placement).toBe('after');
  });
});

describe('adjustInsertionIndex', () => {
  it('passes through when the source is not in the column', () => {
    expect(adjustInsertionIndex(2, null)).toBe(2);
  });

  it('passes through when the source sits at or after the drop slot', () => {
    expect(adjustInsertionIndex(1, 1)).toBe(1);
    expect(adjustInsertionIndex(0, 0)).toBe(0);
  });

  it('shifts by one when the source sits before the drop slot', () => {
    expect(adjustInsertionIndex(1, 0)).toBe(2);
    expect(adjustInsertionIndex(2, 1)).toBe(3);
  });
});
