import { createContext, useContext } from 'react';
import type { DragController } from './DragController';

export const DragControllerContext = createContext<DragController | null>(null);

export function useDragController(): DragController | null {
  return useContext(DragControllerContext);
}
