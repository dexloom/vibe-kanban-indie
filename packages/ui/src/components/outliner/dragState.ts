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
