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
 * Id of the dragged source issue, or `null` when no drag is in flight.
 *
 * Constant for the duration of a single drag — `candidate.sourceIssueId`
 * is set on the first candidate change after promote and never mutates
 * until `onDragEnd` clears it. Source-column cards read this to dim
 * themselves during a drag, even when their column has no live candidate
 * (no card in the column is under the pointer). Kept as its own context
 * so a source-id change does not invalidate candidate consumers (same
 * render-storm discipline as `DragActiveContext` vs
 * `DragCandidateContext`).
 */
export const DragSourceContext = createContext<string | null>(null);

export const DragSourceProvider = DragSourceContext.Provider;

export function useDragSourceIssueId(): string | null {
  return useContext(DragSourceContext);
}

/** Id of the dragged project (project-reorder). Constant within a drag. */
export const DragSourceProjectContext = createContext<string | null>(null);

export const DragSourceProjectProvider = DragSourceProjectContext.Provider;

export function useDragSourceProjectId(): string | null {
  return useContext(DragSourceProjectContext);
}
