import { createContext, useContext } from 'react';
import type { DragController } from './DragController';

export interface DragControllerValue {
  controller: DragController | null;
}

export const DragControllerContext = createContext<DragControllerValue | null>(
  null
);

export function useDragController(): DragControllerValue | null {
  return useContext(DragControllerContext);
}
