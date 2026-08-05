import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useDragController } from './DragContext';
import type { DragSource } from './types';

export interface UseDraggableOptions {
  disabled?: boolean;
}

export function useDraggable(
  source: DragSource,
  options?: UseDraggableOptions,
): {
  onPointerDown: ((e: ReactPointerEvent<HTMLElement>) => void) | null;
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
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!controller) return;
      if (options?.disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target as Element | null;
      // P4-E2 / P5-E2: exempt every focusable / interactive CHILD of the
      // drag source — but NOT the source root itself, which may itself
      // carry `tabIndex` (e.g. `KanbanCard` has a `tabIndex?` prop
      // rendered on the root, so the drag source IS focusable). The
      // P4-E2 `closest(...)` matched the bound source root itself when
      // it had `tabindex="0"` and silently broke drag. Walk from
      // `target` up to `currentTarget` EXCLUSIVE — the source root is
      // exempt, its interactive descendants still are.
      const current = e.currentTarget as Element;
      let node: Element | null = target;
      while (node && node !== current) {
        if (
          node.matches(
            'button, a, input, textarea, select, [contenteditable], [tabindex]',
          )
        ) {
          return;
        }
        node = node.parentElement;
      }
      // Prevent native text selection or touch gestures from hijacking the
      // drag. Synthetic clicks still fire after pointerup, so plain clicks
      // continue to navigation/toggle unless the controller promoted.
      e.preventDefault();
      controller.startPress(sourceRef.current, e.currentTarget, e.nativeEvent);
    },
    [controller, options?.disabled],
  );
  return { onPointerDown: controller ? onPointerDown : null };
}
