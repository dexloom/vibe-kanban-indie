import { describe, expect, it, vi } from 'vitest';
import { createSyncGuard } from './syncGuard';

describe('createSyncGuard', () => {
  it('forwards onSettled args immediately when it fires before the timeout', () => {
    const decrement = vi.fn();
    const guard = createSyncGuard({ decrement });
    const onSettled = vi.fn();
    const bound = guard.bind(onSettled)!;
    bound({ ok: true });
    expect(onSettled).toHaveBeenCalledWith({ ok: true });
    expect(decrement).not.toHaveBeenCalled();
  });

  it('does NOT call onSettled when the timeout fires first (safety net takes over)', () => {
    const decrement = vi.fn();
    // Hook timers so we can flush deterministically.
    let pendingCb: (() => void) | null = null;
    const timers = {
      setTimeout: (cb: () => void) => {
        pendingCb = cb;
        return 1;
      },
      clearTimeout: () => {
        pendingCb = null;
      },
    };
    const guard = createSyncGuard({ decrement, timers });
    const onSettled = vi.fn();
    guard.bind(onSettled);
    expect(onSettled).not.toHaveBeenCalled();
    expect(pendingCb).not.toBeNull();
    // Fire the timeout safety net.
    pendingCb!();
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    expect(guard.hasTimedOut()).toBe(true);
  });

  it('cancels the pending timeout when onSettled fires before the deadline', () => {
    const decrement = vi.fn();
    let pendingCb: (() => void) | null = null;
    let cleared = false;
    const timers = {
      setTimeout: (cb: () => void) => {
        pendingCb = cb;
        return 1;
      },
      clearTimeout: () => {
        cleared = true;
        pendingCb = null;
      },
    };
    const guard = createSyncGuard({ decrement, timers });
    const onSettled = vi.fn();
    const bound = guard.bind(onSettled)!;
    expect(pendingCb).not.toBeNull();
    bound('arg');
    expect(cleared).toBe(true);
    expect(pendingCb).toBeNull();
    expect(onSettled).toHaveBeenCalledWith('arg');
    expect(decrement).not.toHaveBeenCalled();
  });

  it('returns undefined when onSettled is undefined (no-op bind)', () => {
    const guard = createSyncGuard({ decrement: () => {} });
    expect(guard.bind(undefined)).toBeUndefined();
  });

  it('default timeout is 10_000ms', () => {
    const setTimeoutSpy = vi.fn((_cb: () => void, ms: number) => {
      expect(ms).toBe(10_000);
      return 1;
    });
    const guard = createSyncGuard({
      decrement: () => {},
      timers: {
        setTimeout: setTimeoutSpy as unknown as (
          cb: () => void,
          ms: number
        ) => unknown,
        clearTimeout: () => {},
      },
    });
    guard.bind(() => {});
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('cancel() clears the pending timeout (does not call decrement directly)', () => {
    const decrement = vi.fn();
    const timers = {
      setTimeout: () => 1,
      clearTimeout: vi.fn(),
    };
    const guard = createSyncGuard({
      decrement,
      timers,
    });
    guard.bind(() => {});
    guard.cancel();
    expect(timers.clearTimeout).toHaveBeenCalled();
    expect(decrement).not.toHaveBeenCalled();
  });

  it('P5-B1: timeout fires THEN onSettled is called → decrement runs exactly once, onSettled suppressed', () => {
    // Regression for the P5-B1 double-decrement: the 10s safety net
    // decrements the counter so the items-rebuild gate stays open. If
    // the original promise eventually settles (network blip cleared
    // after 12s), the caller's `onSettled` would have ALSO decremented
    // — driving the counter to -1 and silently disabling the gate for
    // subsequent drags. The bound wrapper must suppress the late
    // onSettled when the timeout already fired.
    const decrement = vi.fn();
    let pendingCb: (() => void) | null = null;
    const timers = {
      setTimeout: (cb: () => void) => {
        pendingCb = cb;
        return 1;
      },
      clearTimeout: () => {
        pendingCb = null;
      },
    };
    const guard = createSyncGuard({ decrement, timers });
    const onSettled = vi.fn();
    const bound = guard.bind(onSettled)!;
    // Simulate: 10s safety net fires (network never resolves in time).
    pendingCb!();
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    expect(guard.hasTimedOut()).toBe(true);
    // The request finally settles at t=12s (two seconds after the
    // safety net). bound() must NOT re-decrement and must NOT invoke
    // the caller's onSettled — both branches are already settled.
    bound('late-result');
    expect(decrement).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('multiple bound onSettleds each fire their own timeout (independent guards)', () => {
    const decrement = vi.fn();
    const pendingCbs: Array<() => void> = [];
    const timers = {
      setTimeout: (cb: () => void) => {
        pendingCbs.push(cb);
        return pendingCbs.length;
      },
      clearTimeout: () => {},
    };
    const g1 = createSyncGuard({ decrement, timers });
    const g2 = createSyncGuard({ decrement, timers });
    const o1 = vi.fn();
    const o2 = vi.fn();
    g1.bind(o1);
    g2.bind(o2);
    expect(pendingCbs).toHaveLength(2);
    pendingCbs[0]!();
    expect(decrement).toHaveBeenCalledTimes(1);
    pendingCbs[1]!();
    expect(decrement).toHaveBeenCalledTimes(2);
    expect(o1).not.toHaveBeenCalled();
    expect(o2).not.toHaveBeenCalled();
  });
});
