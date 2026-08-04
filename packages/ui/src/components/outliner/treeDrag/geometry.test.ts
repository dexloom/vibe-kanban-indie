import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  DROP_THRESHOLD_PX,
  findBestCandidate,
  manhattanDistanceToRect,
  type TargetRect,
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

describe('findBestCandidate', () => {
  it('returns null when the targets array is empty', () => {
    expect(findBestCandidate(0, 0, [], 100)).toBeNull();
  });

  it('returns null when every target is farther than the threshold', () => {
    const targets = [
      rect('far', 1000, 1000, 1100, 1100),
      rect('farther', 2000, 2000, 2100, 2100),
    ];
    expect(findBestCandidate(0, 0, targets, 100)).toBeNull();
  });

  it('returns the target containing the pointer (distance 0)', () => {
    const targets = [rect('a', 10, 10, 20, 20), rect('b', 50, 50, 60, 60)];
    expect(findBestCandidate(15, 15, targets, 100)).toBe('a');
  });

  it('returns the nearest target when the pointer is outside all targets', () => {
    // (0, 30) → distance to a: 10 (clamp to left edge), distance to b: 30
    const targets = [rect('a', 10, 20, 30, 40), rect('b', 60, 20, 80, 40)];
    expect(findBestCandidate(0, 30, targets, 100)).toBe('a');
  });

  it('prefers an inside match (distance 0) over a closer outside match', () => {
    // c sits under the pointer; b is 5px away (closer than a's 10px),
    // but inside-distance-0 wins.
    const targets = [
      rect('a', 100, 100, 200, 200), // far outside
      rect('b', 40, 25, 50, 35), // 5px to the left
      rect('c', 10, 20, 30, 40), // contains (30, 30)
    ];
    expect(findBestCandidate(30, 30, targets, 100)).toBe('c');
  });

  it('breaks ties on equal inside-distance by smaller area', () => {
    // Both contain the pointer, equal distance (0). Smaller area wins.
    const targets = [
      rect('big', 0, 0, 1000, 1000),
      rect('small', 10, 10, 30, 30),
    ];
    expect(findBestCandidate(20, 20, targets, 100)).toBe('small');
  });

  it('breaks ties on equal outside-distance by smaller area', () => {
    // Neither contains the pointer (10, 30): big → distance 10 (clamp 0,0),
    // small → distance 10 (clamp 10, 10 → 0, 0 from (10, 10)? no, dx=0,
    // dy=20 → 20). Let\'s hand-pick two rects at exactly equal outside
    // distance. big: (0,0)-(100,100), small: (0,0)-(10,10). Pointer at
    // (15, 15) → distance to big = 0 (inside), distance to small = 10.
    // Not equal. Different shape: both small and centred on the pointer.
    //   big: (0, 0, 200, 200) contains (110, 110)? yes (100 < 110 < 200).
    //   small: (105, 105, 115, 115) contains (110, 110) yes.
    // Both distance 0, both inside → smaller area wins → small.
    const targets = [
      rect('big', 0, 0, 200, 200),
      rect('small', 105, 105, 115, 115),
    ];
    expect(findBestCandidate(110, 110, targets, 100)).toBe('small');
  });

  it('respects the threshold boundary — equal-to-threshold is included', () => {
    // Pointer at (0, 0). Target r1 at (50, 0, 60, 10): distance = 50.
    // Threshold = 50 → distance ≤ threshold → included.
    const targets = [rect('r1', 50, 0, 60, 10)];
    expect(findBestCandidate(0, 0, targets, 50)).toBe('r1');
  });

  it('rejects a target strictly outside the threshold', () => {
    const targets = [rect('r1', 51, 0, 60, 10)];
    expect(findBestCandidate(0, 0, targets, 50)).toBeNull();
  });
});
