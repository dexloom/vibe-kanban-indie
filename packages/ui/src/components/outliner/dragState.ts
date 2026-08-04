import { createContext, useContext } from 'react';

/**
 * True while a unified custom drag is in flight anywhere in the app.
 *
 * Tree status rows and kanban card columns read this to outline possible
 * drop targets during a drag: every status row/column gets a subtle ring
 * while `isDragActive`, and the target under the pointer (the controller's
 * `Candidate`) gets a filled/solid ring + tint.
 *
 * Lives in packages/ui (next to the drop-target rows) and is fed by the
 * shared `DragProvider` via `DragActiveProvider` — web-core imports the
 * provider, ui rows consume the hook (layer-safe).
 */
export const DragActiveContext = createContext<boolean>(false);

export const DragActiveProvider = DragActiveContext.Provider;

export function useDragActive(): boolean {
  return useContext(DragActiveContext);
}

/**
 * Target id of the candidate the unified drag controller currently
 * resolves for the pointer, or `null` when no candidate qualifies.
 *
 * Tree rows and kanban columns render a solid ring on whichever target
 * the pointer is actually over. The controller reconciles both the tree
 * status and kanban column paths via the same React context.
 *
 * Kept as a SEPARATE context from `DragActiveContext` (boolean) so a
 * candidate change does not invalidate every consumer of the boolean
 * context. If we shipped one merged context, a candidate change would
 * re-render every kanban card; with separate contexts only the rows that
 * call `useDragCandidate()` re-render.
 */
export const DragCandidateContext = createContext<string | null>(null);

export const DragCandidateProvider = DragCandidateContext.Provider;

export function useDragCandidate(): string | null {
  return useContext(DragCandidateContext);
}

/**
 * Point within a kanban column where a drag insertion indicator renders.
 * `index` is the slot computed against the column's cards EXCLUDING the
 * dragged source; consumers translate it to the full children array via
 * `adjustInsertionIndex`. `sourceIssueId` lets them locate (and exclude)
 * the source card when it lives in the same column.
 */
export interface InsertionPoint {
  targetId: string;
  index: number;
  sourceIssueId: string | null;
}

export const DragInsertionContext = createContext<InsertionPoint | null>(null);

export const DragInsertionProvider = DragInsertionContext.Provider;

export function useDragInsertion(): InsertionPoint | null {
  return useContext(DragInsertionContext);
}
