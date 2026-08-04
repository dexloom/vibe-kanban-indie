import { createContext, useContext } from 'react';
import type { TreeDragManager } from './TreeDragManager';

/**
 * React context exposing the {@link TreeDragManager} singleton (one per
 * app lifetime, owned by the layout) and a `setDragState` callback the
 * manager can invoke to flip shared drag flags.
 *
 * Lives in packages/ui so the layout (web-core) can wrap the tree without
 * the tree renderer needing to know about the manager class. The hook
 * {@link useTreeDragController} consumes this; the layout provides it.
 */
export interface TreeDragControllerValue {
  manager: TreeDragManager | null;
  setDragState: (s: { isActive: boolean }) => void;
}

export const TreeDragControllerContext =
  createContext<TreeDragControllerValue | null>(null);

/**
 * Returns the current controller or `null` if no provider is mounted.
 * Card rows call this and bail out early (returning a no-op `onMouseDown`)
 * when the controller is unavailable so the tree can still render in unit
 * tests that don\'t wire up the layout.
 */
export function useTreeDragController(): TreeDragControllerValue | null {
  return useContext(TreeDragControllerContext);
}
