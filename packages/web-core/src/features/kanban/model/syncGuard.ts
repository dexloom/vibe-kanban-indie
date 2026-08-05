/**
 * Sync guard for the kanban `isSyncingCountRef` pattern.
 *
 * The board holds a counter that gates the items-rebuild effect so a slow
 * shape-sync doesn't trample the optimistic local order. The counter is
 * incremented at the start of a bulk write and decremented when the write
 * settles.
 *
 * If `bulkUpdateIssues` never settles (network drop, browser tab
 * suspension), the counter would stay >0 forever and the board would be
 * frozen. `createSyncGuard` exposes a `run` helper that wraps a persist
 * call with a 10s timeout safety net: if `onSettled` hasn't fired by then,
 * the counter is decremented anyway.
 *
 * Pure export — no React. The component supplies its own counter ref
 * (which is mutable across renders) and the helper just plumbs it.
 */
export interface SyncGuardOptions {
  /** Decrement counter (called from the timeout safety net). */
  decrement: () => void;
  /** Timeout in ms before the safety net decrements. Defaults to 10s. */
  timeoutMs?: number;
  /** Provide a custom `setTimeout` / `clearTimeout` (test seam). */
  timers?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
}

/** Returns a `bind` factory that wraps a settle callback with the timeout. */
export interface SyncGuard {
  /**
   * Bind a per-call delayed-decrement fallback to a settle callback.
   *
   * Usage:
   * ```ts
   * persistIssues(updates, projectId, {
   *   onError: ...,
   *   onSettled: guard.bind(onSettled),
   * });
   * ```
   *
   * `onSettled` is the caller's own cleanup (decrement counter,
   * invalidate queries, etc). The guard wraps it so the timeout fires
   * `decrement` if `onSettled` never does.
   */
  bind: <T extends unknown[]>(
    onSettled: ((...args: T) => void) | undefined
  ) => ((...args: T) => void) | undefined;
  /** Clears the timeout (no-op if already cleared). */
  cancel: () => void;
  /** Whether the timeout has already fired (defensive: caller can skip
   *  passing a deferred decremented counter twice). */
  hasTimedOut: () => boolean;
}

export function createSyncGuard(options: SyncGuardOptions): SyncGuard {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const setTimeoutFn = options.timers?.setTimeout ?? defaultSetTimeout;
  const clearTimeoutFn = options.timers?.clearTimeout ?? defaultClearTimeout;
  let timeoutId: unknown = null;
  let timedOut = false;

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeoutFn(timeoutId);
      timeoutId = null;
    }
  };

  const bind = <T extends unknown[]>(
    onSettled: ((...args: T) => void) | undefined
  ): ((...args: T) => void) | undefined => {
    if (!onSettled) return undefined;
    timeoutId = setTimeoutFn(() => {
      // The 10s timeout has elapsed without `onSettled` firing. Fire the
      // counter decrement so the items-rebuild gate stays open. From this
      // point the timeout's `decrement()` IS the settle: any eventual
      // `onSettled` (e.g. the request finally resolves seconds later)
      // must be SUPPRESSED — calling the caller's decrement a second
      // time would drift the counter to -1 and re-freeze the gate for
      // the next N drags. The bound wrapper enforces that contract.
      timedOut = true;
      timeoutId = null;
      options.decrement();
    }, timeoutMs);
    return (...args: T) => {
      // Settled before the safety net fired: cancel the deferred
      // decrement and let the caller's existing cleanup run unchanged.
      // If the safety net already fired, suppress — `timedOut` guards
      // the late-call double-decrement (P5-B1).
      cancel();
      if (timedOut) return;
      onSettled(...args);
    };
  };

  return {
    bind,
    cancel,
    hasTimedOut: () => timedOut,
  };
}

const defaultSetTimeout = (cb: () => void, ms: number): unknown => {
  if (typeof globalThis.setTimeout === 'function') {
    return globalThis.setTimeout(cb, ms);
  }
  return null;
};

const defaultClearTimeout = (id: unknown): void => {
  if (id !== null && typeof globalThis.clearTimeout === 'function') {
    globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>);
  }
};
