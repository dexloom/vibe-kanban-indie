import type { Placement } from './types';

export interface CardRect {
  top: number;
  bottom: number;
}

/** Subset of {@link Candidate} that the geometry layer can resolve from a
 * pointer position + cached rects. The controller composes the full
 * Candidate (adding index + sourceIssueId) in `resolveCandidateAt` so
 * `findBestCandidate` stays focused on pure geometry. */
export interface TargetCandidate {
  targetId: string | null;
  placement: Placement | null;
}

/**
 * Insertion slot for pointerY against sorted card rects (midpoint split):
 * pointerY below a card's midpoint → insert AFTER it, else BEFORE it.
 * Returns 0 when above the first card / when there are no cards, and
 * `cards.length` when below the last card.
 */
export function computeInsertIndex(
  pointerY: number,
  cards: readonly CardRect[],
): number {
  if (cards.length === 0) return 0;
  for (let i = 0; i < cards.length; i++) {
    const midpoint = (cards[i].top + cards[i].bottom) / 2;
    if (pointerY < midpoint) return i;
  }
  return cards.length;
}

/**
 * Translate a drop index (computed against the column's cards EXCLUDING the
 * dragged source, which is on its way out) into the indicator's position in
 * the FULL rendered children array. When the source card sits at a lower
 * index than the drop slot, every following child shifts up by one once the
 * source leaves, so the indicator must be placed one slot later.
 *
 * `sourceFullIndex` = index of the source card in the full children array,
 * or `null` when the source is not in this column (cross-column drop).
 */
export function adjustInsertionIndex(
  index: number,
  sourceFullIndex: number | null,
): number {
  if (sourceFullIndex === null || sourceFullIndex >= index) return index;
  return index + 1;
}

export interface TargetRect {
  droppableId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const DRAG_THRESHOLD_PX = 5;

export const DROP_THRESHOLD_PX = 32;

export function manhattanDistanceToRect(
  x: number,
  y: number,
  r: TargetRect,
): number {
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
    return 0;
  }
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return dx + dy;
}

/**
 * Vertical-third placement of the pointer against the target rect.
 *
 *  - top third → `'before'`
 *  - middle third → `'on'`
 *  - bottom third → `'after'`
 */
export function computePlacement(y: number, r: TargetRect): Placement {
  const height = r.bottom - r.top;
  const topThird = r.top + height / 3;
  const bottomThird = r.bottom - height / 3;
  if (y < topThird) return 'before';
  if (y > bottomThird) return 'after';
  return 'on';
}

/**
 * Pick the best drop candidate from `targets` for the pointer at `(x, y)`.
 *
 * Selection rules:
 *  1. Skip rects farther than `threshold` px (magnetic radius).
 *  2. Lowest manhattan distance wins.
 *  3. On a distance tie, smaller area wins (prefer the tightest match).
 *  4. No candidates in range → `{ targetId: null, placement: null }`.
 *
 * Returns a {@link TargetCandidate} with the winning target's `droppableId`
 * (or `null`) and the placement computed against the winning rect. The
 * controller layers `index` + `sourceIssueId` on top in `resolveCandidateAt`.
 */
export function findBestCandidate(
  x: number,
  y: number,
  targets: readonly TargetRect[],
  threshold: number,
): TargetCandidate {
  if (targets.length === 0) {
    return { targetId: null, placement: null };
  }

  let bestTarget: TargetRect | null = null;
  let bestDist = Infinity;
  let bestArea = Infinity;

  for (const target of targets) {
    const dist = manhattanDistanceToRect(x, y, target);
    if (dist > threshold) continue;

    const area = (target.right - target.left) * (target.bottom - target.top);

    if (dist < bestDist) {
      bestDist = dist;
      bestArea = area;
      bestTarget = target;
      continue;
    }
    if (dist === bestDist && area < bestArea && bestTarget) {
      bestArea = area;
      bestTarget = target;
    }
  }

  if (!bestTarget) {
    return { targetId: null, placement: null };
  }
  return {
    targetId: bestTarget.droppableId,
    placement: computePlacement(y, bestTarget),
  };
}
