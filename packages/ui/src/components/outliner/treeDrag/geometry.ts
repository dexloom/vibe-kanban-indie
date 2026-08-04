/**
 * Pure geometry helpers for the custom tree drag manager.
 *
 * Two operations:
 *  - {@link manhattanDistanceToRect}: clamps a point to a rect's nearest edge
 *    and returns the L1 distance (0 when the point is inside the rect).
 *  - {@link findBestCandidate}: picks the nearest of N drop targets by
 *    manhattan distance, with two tie-breakers (inside wins, then smaller
 *    area) and a threshold that vetoes weak matches.
 *
 * No React, no DOM — the manager passes a plain {@link TargetRect} array.
 * Lives in `packages/ui` next to the tree; nothing imports from web-core.
 */
export interface TargetRect {
  droppableId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Promote from "pressing" to "dragging" once the pointer has moved this
 * many pixels from the press origin. Keeps plain clicks from accidentally
 * lifting a ghost. */
export const DRAG_THRESHOLD_PX = 5;

/** Magnetic radius (px) for picking a candidate drop target during a drag.
 * Targets farther than this from the pointer are skipped. */
export const DROP_THRESHOLD_PX = 32;

/**
 * Manhattan distance from the point `(x, y)` to the rect.
 *
 *  - If the point is inside both the horizontal and vertical spans of the
 *    rect, returns 0 (pointer is "on" the target).
 *  - Otherwise, clamps the point to the rect's nearest edge and returns
 *    `|dx| + |dy|`.
 *
 * Used by {@link findBestCandidate} and exposed for callers that want the
 * raw distance (e.g. debug overlays).
 */
export function manhattanDistanceToRect(
  x: number,
  y: number,
  r: TargetRect,
): number {
  // Inside both spans → distance is 0 (pointer is over the target).
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
    return 0;
  }
  const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
  const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
  return dx + dy;
}

/**
 * Pick the best drop candidate from `targets` for the pointer at `(x, y)`.
 *
 * Selection rules:
 *  1. Skip rects farther than `threshold` px (magnetic radius).
 *  2. Lowest manhattan distance wins.
 *  3. Tie-breaker 1: an inside-distance (0) beats an outside-distance.
 *     (Two inside candidates → both distance 0; the next rule decides.)
 *  4. Tie-breaker 2: smaller area wins (prefer the tightest match).
 *  5. No candidates in range → `null`.
 *
 * Returns the winning target's `droppableId`, or `null` if none qualify.
 */
export function findBestCandidate(
  x: number,
  y: number,
  targets: readonly TargetRect[],
  threshold: number,
): string | null {
  if (targets.length === 0) return null;

  let bestId: string | null = null;
  let bestDist = Infinity;
  let bestArea = Infinity;
  let bestInside = false;

  for (const target of targets) {
    const dist = manhattanDistanceToRect(x, y, target);
    if (dist > threshold) continue;

    const inside = dist === 0;
    const area = (target.right - target.left) * (target.bottom - target.top);

    // Strictly smaller distance wins.
    if (dist < bestDist) {
      bestDist = dist;
      bestInside = inside;
      bestArea = area;
      bestId = target.droppableId;
      continue;
    }
    // Equal distance: prefer an inside match over an outside match.
    if (dist === bestDist && inside && !bestInside) {
      bestInside = true;
      bestArea = area;
      bestId = target.droppableId;
      continue;
    }
    // Equal distance AND both inside (or both outside): prefer the smaller
    // target so the magnetic snap hugs the tightest column rather than a
    // wide region (e.g. the whole sidebar).
    if (dist === bestDist && inside === bestInside && area < bestArea) {
      bestArea = area;
      bestId = target.droppableId;
    }
  }

  return bestId;
}
