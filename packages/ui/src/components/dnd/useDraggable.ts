import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
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
  // The callback is bound ONCE per (controller, disabled) change so
  // virtualized tree rows don't see a fresh handler every scroll frame.
  // `source` is read through a ref — callers pass fresh
  // `{kind, issueId, projectId}` literals on each render, which would
  // otherwise re-bind this callback (and the inner `controller.startPress`
  // dispatch) on every paint.
  const sourceRef = useRef(source);
  sourceRef.current = source;
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
      controller.startPress(sourceRef.current, e.currentTarget, e.nativeEvent);
    },
    [controller, options?.disabled],
  );
  return { onMouseDown: controller ? onMouseDown : null };
}
