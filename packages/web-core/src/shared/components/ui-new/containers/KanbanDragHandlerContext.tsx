import { createContext, useContext, type ReactNode } from 'react';

/**
 * Bridge between the shared custom drag system (`DragProvider`) and the
 * kanban board's intra-kanban handler. Kanban-internal drags (source is
 * an issue-move AND destination is a bare-UUID kanban column) are
 * delegated to the registered handler via this ref so the kanban board
 * can keep its `setItems` + `bulkUpdateIssues` flow. Cross-surface drops
 * go through `bulkUpdateIssues` directly in the layout.
 */
export interface KanbanMove {
  issueId: string;
  fromStatusId: string;
  toStatusId: string;
  /** Position in the destination column; 'end' appends (custom cross-surface
   * drags). A number is used only by the legacy list-view adapter (index
   * reorder). */
  destIndex?: number | 'end';
}

export type KanbanDragHandler = (move: KanbanMove) => void;

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
 * Lookup shape consumed by the cross-surface `resolveDragEnd`. Kept
 * narrow so callers can build the map cheaply from their shape
 * collection without widening the surface.
 */
export type IssueDragLookup = Readonly<{
  id: string;
  project_id: string;
  status_id: string;
}>;
