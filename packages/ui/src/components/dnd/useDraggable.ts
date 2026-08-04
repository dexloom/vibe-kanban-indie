import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { useDragController } from './DragContext';
import type { DragSource } from './types';

export interface UseDraggableOptions {
  disabled?: boolean;
}

export function useDraggable(
  source: DragSource,
  options?: UseDraggableOptions,
): {
  onMouseDown: ((e: ReactMouseEvent<HTMLElement>) => void) | null;
} {
  const controller = useDragController();
  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!controller) return;
      if (options?.disabled) return;
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest('button')) return;
      // Prevent native text selection from hijacking the gesture: mousedown
      // on the card body would otherwise start a browser selection instead
      // of the drag. preventDefault on mousedown does NOT suppress the click
      // event (it fires on mouseup regardless), so plain clicks still fall
      // through to navigation/toggle.
      e.preventDefault();
      controller.controller?.startPress(source, e.currentTarget, e.nativeEvent);
    },
    [controller, options?.disabled, source],
  );
  return { onMouseDown: controller ? onMouseDown : null };
}
