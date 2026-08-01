/**
 * Conversation Virtualizer Hook
 *
 * Owns the TanStack Virtual instance for the conversation list, the bottom-lock
 * autoscroll state, and all imperative scroll commands. The previous design
 * split this across three files (virtualizer + a scroll-intent state machine +
 * a command executor); that indirection is what let the bottom lock get
 * falsely released during streaming. Here everything lives in one place and
 * programmatic scrolls are guarded with a boolean flag instead of a wall-clock
 * deadline.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  useVirtualizer,
  measureElement as defaultMeasureElement,
} from '@tanstack/react-virtual';
import type { Virtualizer, VirtualItem } from '@tanstack/react-virtual';

import {
  type ConversationRow,
  SIZE_ESTIMATE_PX,
  estimateSizeForRow,
  findPreviousUserMessageIndex,
} from './conversation-row-model';
import type { AddEntryType } from '@/shared/hooks/useConversationHistory/types';

/** Pixel distance from bottom within which the user is considered "at bottom". */
const NEAR_BOTTOM_THRESHOLD_PX = 64;

type ScrollToOptionsBehavior = 'auto' | 'smooth';

const OVERSCAN = 8;

export interface ConversationVirtualizerOptions {
  rows: ConversationRow[];
  totalRowCount: number;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onAtBottomChange?: (atBottom: boolean) => void;
  shouldSuppressSizeAdjustment?: () => boolean;
}

export interface ConversationVirtualizerResult {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  virtualItems: VirtualItem[];
  totalSize: number;
  measureElement: (node: Element | null) => void;
  scrollToBottom: (behavior?: ScrollToOptionsBehavior) => void;
  scrollToIndex: (
    index: number,
    options?: {
      align?: 'start' | 'center' | 'end';
      behavior?: ScrollToOptionsBehavior;
    }
  ) => void;
  scrollToPreviousUserMessage: () => boolean;

  /**
   * Call after conversation entries change (from the shell's rAF flush). The
   * hook decides whether to follow the bottom (only when the user is at/near
   * it) or preserve the viewport.
   */
  handleEntriesChanged: (addType: AddEntryType, isInitialLoad: boolean) => void;
  isAtBottom: boolean;
  checkIsAtBottom: () => boolean;
  releaseBottomLock: () => void;
  rowIndexForVirtualItem: (item: VirtualItem) => number;
  rowForVirtualItem: (item: VirtualItem) => ConversationRow | undefined;
}

export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number
): boolean {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollHeight)
  ) {
    return true;
  }
  return scrollHeight - clientHeight - scrollTop <= NEAR_BOTTOM_THRESHOLD_PX;
}

export function useConversationVirtualizer({
  rows,
  totalRowCount,
  scrollContainerRef,
  onAtBottomChange,
  shouldSuppressSizeAdjustment,
}: ConversationVirtualizerOptions): ConversationVirtualizerResult {
  const bottomLockedRef = useRef(false);

  // Guards the lock-release heuristic in the scroll handler. Any programmatic
  // scrollTop mutation sets this flag until the next animation frame, so the
  // scroll events it fires are not misread as a user-initiated upward scroll
  // (which is what previously released the bottom lock mid-stream).
  const isProgrammaticScrollRef = useRef(false);

  const setScrollTopProgrammatic = useCallback(
    (el: HTMLDivElement, top: number) => {
      isProgrammaticScrollRef.current = true;
      el.scrollTop = top;
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    },
    []
  );

  const isBottomScrollCorrectionActive = useCallback(
    () => bottomLockedRef.current,
    []
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return SIZE_ESTIMATE_PX.medium;
      const containerWidth = scrollContainerRef.current?.clientWidth ?? null;
      return estimateSizeForRow(row, containerWidth);
    },
    getItemKey: (index) => {
      const row = rows[index];
      return row ? row.semanticKey : index;
    },
    overscan: OVERSCAN,
    measureElement: defaultMeasureElement,
    useAnimationFrameWithResizeObserver: false,
  });

  // Preserve the reader's position only when a row fully above the viewport
  // changes size. Suppressed during programmatic scrolls and interaction
  // anchor corrections.
  useEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance
    ) => {
      const scrollElement = scrollContainerRef.current;
      const viewportHeight =
        scrollElement?.clientHeight ?? instance.scrollRect?.height ?? 0;
      const scrollOffset =
        scrollElement?.scrollTop ?? instance.scrollOffset ?? 0;
      const totalScrollableSize =
        scrollElement?.scrollHeight ?? instance.getTotalSize();
      const remainingDistance =
        totalScrollableSize - (scrollOffset + viewportHeight);
      const isItemFullyAboveViewport = item.end <= scrollOffset;

      return (
        !isProgrammaticScrollRef.current &&
        !bottomLockedRef.current &&
        !shouldSuppressSizeAdjustment?.() &&
        isItemFullyAboveViewport &&
        remainingDistance > NEAR_BOTTOM_THRESHOLD_PX
      );
    };

    return () => {
      virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [shouldSuppressSizeAdjustment, virtualizer]);

  // -------------------------------------------------------------------------
  // Reactive isAtBottom state
  // -------------------------------------------------------------------------

  const [isAtBottomState, setIsAtBottomState] = useState(true);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  onAtBottomChangeRef.current = onAtBottomChange;
  const lastAtBottomRef = useRef(true);

  const syncIsAtBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    const nextValue = isBottomScrollCorrectionActive()
      ? true
      : el
        ? isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
        : true;

    if (nextValue !== lastAtBottomRef.current) {
      lastAtBottomRef.current = nextValue;
      setIsAtBottomState(nextValue);
      onAtBottomChangeRef.current?.(nextValue);
      return;
    }

    setIsAtBottomState((current) =>
      current === nextValue ? current : nextValue
    );
  }, [isBottomScrollCorrectionActive, scrollContainerRef]);

  const prevScrollTopRef = useRef(0);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    prevScrollTopRef.current = el.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = el.scrollTop;

      // Release the bottom lock only on a real user-initiated upward scroll,
      // never on a programmatic one (guarded by isProgrammaticScrollRef) and
      // never while an interaction anchor correction is in flight.
      if (
        bottomLockedRef.current &&
        prevScrollTopRef.current - currentScrollTop > 5 &&
        !isProgrammaticScrollRef.current &&
        !shouldSuppressSizeAdjustment?.()
      ) {
        bottomLockedRef.current = false;
      }

      prevScrollTopRef.current = currentScrollTop;
      syncIsAtBottom();
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => {
      el.removeEventListener('scroll', handleScroll);
    };
  }, [scrollContainerRef, shouldSuppressSizeAdjustment, syncIsAtBottom]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Bottom-lock correction: after measurement, keep the viewport pinned to the
  // bottom while locked. `totalRowCount` is the total including the
  // unvirtualized streaming tail (which grows `scrollHeight` without changing
  // `rows.length` or `totalSize`).
  useLayoutEffect(() => {
    syncIsAtBottom();

    if (!bottomLockedRef.current) return;

    const el = scrollContainerRef.current;
    if (!el) return;

    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll > 0 && Math.abs(maxScroll - el.scrollTop) > 1) {
      setScrollTopProgrammatic(el, maxScroll);
    }
  }, [
    rows.length,
    totalRowCount,
    totalSize,
    syncIsAtBottom,
    scrollContainerRef,
    setScrollTopProgrammatic,
  ]);

  // -------------------------------------------------------------------------
  // Scroll commands
  // -------------------------------------------------------------------------

  const scrollToBottom = useCallback(
    (behavior: ScrollToOptionsBehavior = 'smooth') => {
      const el = scrollContainerRef.current;
      if (!el) return;

      bottomLockedRef.current = true;

      if (behavior === 'smooth') {
        isProgrammaticScrollRef.current = true;
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      } else {
        setScrollTopProgrammatic(el, el.scrollHeight - el.clientHeight);
      }
    },
    [scrollContainerRef, setScrollTopProgrammatic]
  );

  const scrollToIndex = useCallback(
    (
      index: number,
      options?: {
        align?: 'start' | 'center' | 'end';
        behavior?: ScrollToOptionsBehavior;
      }
    ) => {
      bottomLockedRef.current = false;
      virtualizer.scrollToIndex(index, {
        align: options?.align ?? 'start',
        behavior: options?.behavior ?? 'smooth',
      });
    },
    [virtualizer]
  );

  const scrollToPreviousUserMessage = useCallback((): boolean => {
    const scrollEl = scrollContainerRef.current;
    const items = virtualizer.getVirtualItems();
    if (items.length === 0 || rows.length === 0 || !scrollEl) return false;

    bottomLockedRef.current = false;

    const firstVisibleIndex =
      virtualizer.getVirtualItemForOffset(scrollEl.scrollTop)?.index ??
      items[0].index;
    const targetIndex = findPreviousUserMessageIndex(rows, firstVisibleIndex);

    if (targetIndex < 0) return false;

    virtualizer.scrollToIndex(targetIndex, {
      align: 'start',
      behavior: 'smooth',
    });
    return true;
  }, [scrollContainerRef, virtualizer, rows]);

  const checkIsAtBottom = useCallback((): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return isNearBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  }, [scrollContainerRef]);

  const releaseBottomLock = useCallback(() => {
    bottomLockedRef.current = false;
  }, []);

  // -------------------------------------------------------------------------
  // Entry-change handling (replaces the old scroll-intent state machine)
  // -------------------------------------------------------------------------

  const handleEntriesChanged = useCallback(
    (addType: AddEntryType, isInitialLoad: boolean) => {
      if (isInitialLoad) {
        scrollToBottom('auto');
        return;
      }

      const atBottom = checkIsAtBottom();

      if (addType === 'plan') {
        if (atBottom && rows.length > 0) {
          scrollToIndex(rows.length - 1, { align: 'start', behavior: 'auto' });
        }
        return;
      }

      if (atBottom) {
        scrollToBottom('auto');
      }
    },
    [checkIsAtBottom, rows.length, scrollToBottom, scrollToIndex]
  );

  // -------------------------------------------------------------------------
  // Row ↔ VirtualItem mapping
  // -------------------------------------------------------------------------

  const rowIndexForVirtualItem = useCallback(
    (item: VirtualItem): number => item.index,
    []
  );

  const rowForVirtualItem = useCallback(
    (item: VirtualItem): ConversationRow | undefined => rows[item.index],
    [rows]
  );

  const measureElement = useCallback(
    (node: Element | null) => {
      virtualizer.measureElement(node);
    },
    [virtualizer]
  );

  return {
    virtualizer,
    virtualItems,
    totalSize,
    measureElement,
    scrollToBottom,
    scrollToIndex,
    scrollToPreviousUserMessage,
    handleEntriesChanged,
    isAtBottom: isAtBottomState,
    checkIsAtBottom,
    releaseBottomLock,
    rowIndexForVirtualItem,
    rowForVirtualItem,
  };
}
