import { createContext, useContext, type ReactNode } from 'react';
import type {
  KanbanDragHandler,
  KanbanMove,
} from '@/features/kanban/model/kanbanMove';

// Re-exported from `model/kanbanMove` so pure logic (computeKanbanMove
// and its tests) does not depend on React wiring. Existing imports of
// `KanbanMove` / `KanbanDragHandler` from this module keep compiling.
export type { KanbanMove, KanbanDragHandler };

/**
 * Bridge between the shared custom drag system (`DragProvider`) and the
 * kanban board's intra-kanban handler. Kanban-internal drags (source is
 * an issue-move AND destination is a bare-UUID kanban column) are
 * delegated to the registered handler via this ref so the kanban board
 * can keep its `setItems` + `bulkUpdateIssues` flow. Cross-surface drops
 * go through `bulkUpdateIssues` directly in the layout.
 */
export interface KanbanDragHandlerContextValue {
  /**
   * Register a kanban-internal move handler. Returns a cleanup callback
   * the caller runs on unmount to clear the bridge (the live definition
   * lives in `SharedAppLayout`, which nulls its ref via the returned
   * cleanup; the dev fallback below is a no-op for symmetry).
   */
  registerHandler: (handler: KanbanDragHandler) => () => void;
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
    // No provider above us — typically a misuse of this hook outside the
    // shared layout. Surface the misconfiguration in dev so the omission
    // is not silently swallowed; the layout-side resolver still falls
    // back to drop rejection.
    if (
      typeof process !== 'undefined' &&
      process.env?.NODE_ENV !== 'production'
    ) {
      console.warn(
        'useKanbanDragHandler called outside <KanbanDragHandlerProvider>; kanban-internal drops will be rejected.'
      );
    }
    return {
      registerHandler: (_handler: KanbanDragHandler): (() => void) => {
        return () => {};
      },
    };
  }
  return ctx;
}
