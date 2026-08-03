import { createContext, useContext, type ReactNode } from 'react';
import type { DropResult } from '@hello-pangea/dnd';

/**
 * Bridge between SharedAppLayout's top-level <DragDropContext> and the
 * KanbanContainer's existing in-kanban handler (PLAN §6.2). Kanban-internal
 * drags (both source and destination bare-UUID kanban columns) are delegated
 * to the registered handler via this ref so the kanban board can keep its
 * optimised setItems + bulkUpdateIssues flow; cross-surface drops go
 * directly through bulkUpdateIssues in the layout.
 */
export type KanbanDragHandler = (result: DropResult) => void;

export interface KanbanDragHandlerContextValue {
  registerHandler: (handler: KanbanDragHandler) => void;
}

const KanbanDragHandlerContext =
  createContext<KanbanDragHandlerContextValue | null>(null);

export function KanbanDragHandlerProvider({
  value,
  children,
}: {
  value: KanbanDragHandlerContextValue;
  children: ReactNode;
}) {
  return (
    <KanbanDragHandlerContext.Provider value={value}>
      {children}
    </KanbanDragHandlerContext.Provider>
  );
}

export function useKanbanDragHandler(): KanbanDragHandlerContextValue {
  const ctx = useContext(KanbanDragHandlerContext);
  if (!ctx) {
    // `registerHandler` here is a placeholder taking the handler but not
    // storing it; the layout-side resolver falls back to drop rejection.
    return {
      registerHandler: (_handler: KanbanDragHandler): void => {
        /* no-op */
      },
    };
  }
  return ctx;
}

/**
 * Lookup shape consumed by the cross-surface `resolveDragEnd` (PLAN §6.2).
 * Kept narrow so callers can build the map cheaply from their shape
 * collection without widening the surface.
 */
export type IssueDragLookup = Readonly<{
  id: string;
  project_id: string;
  status_id: string;
}>;
