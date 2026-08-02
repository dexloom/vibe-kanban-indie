import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type RefObject,
} from 'react';

/**
 * Keeps a clicked interactive element (button, summary, etc.) pinned to its
 * viewport position while the surrounding conversation reflows during
 * streaming. When the user clicks an expandable/collapsible row, the anchor
 * correction compensates for the layout shift so the clicked element doesn't
 * visually jump.
 *
 * `isCorrectionActive()` feeds the virtualizer's size-adjustment suppressor so
 * mid-anchor corrections don't fight the follow-bottom logic.
 */
export function useInteractionAnchor({
  scrollContainerRef,
}: {
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}): {
  handleClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
  isCorrectionActive: () => boolean;
} {
  const pendingAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(
    null
  );
  const pendingAnchorFrameRef = useRef<number | null>(null);
  const pendingAnchorDeadlineRef = useRef(0);

  const clearPendingAnchor = useCallback(() => {
    if (pendingAnchorFrameRef.current !== null) {
      cancelAnimationFrame(pendingAnchorFrameRef.current);
      pendingAnchorFrameRef.current = null;
    }
    pendingAnchorDeadlineRef.current = 0;
    pendingAnchorRef.current = null;
  }, []);

  const isCorrectionActive = useCallback(
    () =>
      pendingAnchorRef.current !== null &&
      performance.now() < pendingAnchorDeadlineRef.current,
    []
  );

  const runAnchorCorrection = useCallback(() => {
    pendingAnchorFrameRef.current = null;

    const anchor = pendingAnchorRef.current;
    const scrollContainer = scrollContainerRef.current;
    if (!anchor || !scrollContainer || !anchor.element.isConnected) {
      clearPendingAnchor();
      return;
    }

    const currentTop = anchor.element.getBoundingClientRect().top;
    const delta = currentTop - anchor.top;
    if (Math.abs(delta) >= 0.5) {
      scrollContainer.scrollTop += delta;
    }

    if (performance.now() < pendingAnchorDeadlineRef.current) {
      pendingAnchorFrameRef.current =
        requestAnimationFrame(runAnchorCorrection);
      return;
    }

    clearPendingAnchor();
  }, [clearPendingAnchor, scrollContainerRef]);

  const handleClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const trigger = target.closest<HTMLElement>(
        'button, summary, [role="button"], [data-scroll-anchor-target]'
      );
      if (!trigger || trigger.closest('[data-scroll-anchor-ignore]')) return;

      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer || !scrollContainer.contains(trigger)) return;

      clearPendingAnchor();
      pendingAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      pendingAnchorDeadlineRef.current = performance.now() + 250;
      pendingAnchorFrameRef.current =
        requestAnimationFrame(runAnchorCorrection);
    },
    [clearPendingAnchor, runAnchorCorrection, scrollContainerRef]
  );

  // Cancel any in-flight correction on unmount.
  useEffect(() => {
    return () => {
      if (pendingAnchorFrameRef.current !== null) {
        cancelAnimationFrame(pendingAnchorFrameRef.current);
      }
    };
  }, []);

  return { handleClickCapture, isCorrectionActive };
}
