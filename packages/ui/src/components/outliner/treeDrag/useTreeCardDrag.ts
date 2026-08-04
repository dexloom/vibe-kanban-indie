import type { MouseEvent as ReactMouseEvent } from 'react';
import { useCallback } from 'react';
import { useTreeDragController } from './TreeDragControllerContext';

/**
 * Hook used by `CardNodeRow` to bind its `onMouseDown` to the
 * {@link TreeDragManager} owned by the layout.
 *
 *  - Returns `null` `onMouseDown` if the controller is unavailable
 *    (e.g. unit tests that don\'t wire up the provider).
 *  - Skips the press if `isMultiSelectActive` is true — bulk-select mode
 *    owns the mouse.
 *  - Skips the press if the press started on a `<button>` (the caret toggle
 *    sits inside the row and must not start a drag when clicked).
 *  - Skips the press for non-primary mouse buttons (right/middle click).
 *
 * Does NOT call `preventDefault` on mousedown — we let the browser fire
 * its synthetic click on mouseup if the user didn\'t move past the
 * threshold, so plain clicks still fall through to react-arborist\'s
 * outer DefaultRow.
 */
export function useTreeCardDrag(
  issueId: string,
  projectId: string,
  isMultiSelectActive: boolean,
): {
  onMouseDown: ((e: ReactMouseEvent<HTMLDivElement>) => void) | null;
} {
  const controller = useTreeDragController();
  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!controller) return;
      if (isMultiSelectActive) return;
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest('button')) return;
      controller.manager?.startPress(
        issueId,
        projectId,
        e.nativeEvent,
        controller.setDragState,
      );
    },
    [controller, isMultiSelectActive, issueId, projectId],
  );

  return { onMouseDown: controller ? onMouseDown : null };
}
