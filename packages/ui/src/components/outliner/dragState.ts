import { createContext, useContext } from 'react';

/**
 * True while a hello-pangea drag is in flight anywhere in the app.
 *
 * The tree Droppables (`StatusNodeRow`, per-card droppables) read this to
 * outline possible drop targets during a drag: every status row gets a subtle
 * ring while `isDragActive`, and the row under the pointer (hello-pangea
 * `snapshot.isDraggingOver`) gets a filled/solid ring + tint.
 *
 * Lives in packages/ui (next to the Droppables) and is fed by the layout's
 * `DragDropContext` `onDragStart`/`onDragEnd` via `DragActiveProvider` —
 * web-core imports the provider, ui rows consume the hook (layer-safe).
 */
export const DragActiveContext = createContext<boolean>(false);

export const DragActiveProvider = DragActiveContext.Provider;

export function useDragActive(): boolean {
  return useContext(DragActiveContext);
}

/**
 * Droppable id of the candidate the custom tree drag manager currently
 * resolves for the pointer, or `null` when no candidate qualifies.
 *
 * Tree rows and kanban cards union this with their own hello-pangea
 * snapshot to render a solid ring on whichever target the pointer is
 * actually over — covers both hello-pangea kanban→tree (StatusNodeRow\'s
 * Droppable) and the custom tree→tree / tree→kanban path.
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
