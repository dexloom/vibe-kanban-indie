import { describe, expect, it, vi } from 'vitest';

const bulkUpdateIssues = vi.fn();
const bulkUpdateProjects = vi.fn();
const refreshShapeSource = vi.fn();

vi.mock('@/shared/lib/remoteApi', () => ({
  bulkUpdateIssues: (...args: unknown[]) => bulkUpdateIssues(...args),
  bulkUpdateProjects: (...args: unknown[]) => bulkUpdateProjects(...args),
}));

vi.mock('@/shared/lib/electric/collections', () => ({
  refreshShapeSource: (...args: unknown[]) => refreshShapeSource(...args),
}));

vi.mock('shared/remote-types', () => ({
  PROJECT_ISSUES_SHAPE: { table: 'project_issues_test' },
  PROJECTS_SHAPE: { table: 'projects_test' },
}));

import {
  persistIssues,
  persistIssueSwap,
  persistProjectReorder,
  type PersistIssueSwapPair,
} from './persistIssues';
import type { BulkUpdateIssueItem } from '@/shared/lib/remoteApi';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('persistIssues', () => {
  it('calls bulkUpdateIssues with the exact payload and refreshShapeSource on success', async () => {
    const d = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();

    const onError = vi.fn();
    const onSettled = vi.fn();
    const updates: BulkUpdateIssueItem[] = [
      { id: 'issue-1', changes: { status_id: 'todo' } },
      { id: 'issue-2', changes: { sort_order: 100 } },
    ];
    persistIssues(updates, 'project-1', { onError, onSettled });

    expect(bulkUpdateIssues).toHaveBeenCalledTimes(1);
    expect(bulkUpdateIssues).toHaveBeenCalledWith(updates);
    // Resolve bulk → refresh fires.
    d.resolve();
    await d.promise;
    // Microtask drain for the .then handler.
    await Promise.resolve();
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    expect(refreshShapeSource).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'project_issues_test' }),
      { project_id: 'project-1' }
    );
    expect(onError).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('calls onError once and refresh once on bulk rejection (no double-refresh)', async () => {
    // P3-E1 regression guard: a bulk rejection must trigger exactly ONE
    // refresh (the catch handler), not the original-then + catch chain
    // (the old `then(refresh).catch(refresh)` form refreshed twice).
    const d = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();

    const onError = vi.fn();
    const onSettled = vi.fn();
    persistIssues(
      [{ id: 'issue-1', changes: { status_id: 'todo' } }],
      'project-1',
      { onError, onSettled }
    );

    const err = new Error('bulk failed');
    d.reject(err);
    // Let the promise chain settle.
    await new Promise((res) => setTimeout(res, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('treats refresh failure as non-fatal (no onError, no double refresh)', async () => {
    // P3-E1: the OLD code did `.then(refresh).catch(refresh)`, which
    // misattributed a refresh failure as a bulk failure (wrong onError)
    // AND refreshed twice (then's refresh + catch's refresh). The new
    // code wraps the refresh in a try/catch so a refresh rejection
    // never escapes as a bulk rejection.
    const d = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();
    // Make refresh throw synchronously on first call.
    refreshShapeSource.mockImplementationOnce(() => {
      throw new Error('refresh kaboom');
    });

    const onError = vi.fn();
    const onSettled = vi.fn();
    persistIssues(
      [{ id: 'issue-1', changes: { status_id: 'todo' } }],
      'project-1',
      { onError, onSettled }
    );

    d.resolve();
    await new Promise((res) => setTimeout(res, 0));

    expect(onError).not.toHaveBeenCalled();
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('runs onSettled in both success and failure paths', async () => {
    // Success path.
    const dOk = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(dOk.promise);
    refreshShapeSource.mockReset();
    const okSettled = vi.fn();
    persistIssues(
      [{ id: 'issue-1', changes: { status_id: 'todo' } }],
      'project-1',
      { onSettled: okSettled }
    );
    dOk.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(okSettled).toHaveBeenCalledTimes(1);

    // Failure path.
    const dFail = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(dFail.promise);
    refreshShapeSource.mockReset();
    const failSettled = vi.fn();
    persistIssues(
      [{ id: 'issue-1', changes: { status_id: 'todo' } }],
      'project-1',
      { onSettled: failSettled }
    );
    dFail.reject(new Error('bulk failed'));
    await new Promise((res) => setTimeout(res, 0));
    expect(failSettled).toHaveBeenCalledTimes(1);
  });
});

describe('persistIssueSwap', () => {
  it('builds the swapped payload (a→b, b→a) and forwards to persistIssues', async () => {
    const d = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();

    const onError = vi.fn();
    persistIssueSwap(
      { id: 'a', status_id: 'status-A', sort_order: 1 },
      { id: 'b', status_id: 'status-B', sort_order: 2 },
      'project-1',
      { onError }
    );

    expect(bulkUpdateIssues).toHaveBeenCalledTimes(1);
    const expected: PersistIssueSwapPair[] = [
      { id: 'a', changes: { status_id: 'status-B', sort_order: 2 } },
      { id: 'b', changes: { status_id: 'status-A', sort_order: 1 } },
    ];
    expect(bulkUpdateIssues).toHaveBeenCalledWith(expected);

    d.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards onError and onSettled from persistIssueSwap to the underlying persistIssues call', async () => {
    const d = deferred<void>();
    bulkUpdateIssues.mockReset();
    bulkUpdateIssues.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();

    const onError = vi.fn();
    const onSettled = vi.fn();
    persistIssueSwap(
      { id: 'a', status_id: 'status-A', sort_order: 1 },
      { id: 'b', status_id: 'status-B', sort_order: 2 },
      'project-1',
      { onError, onSettled }
    );

    const err = new Error('bulk failed');
    d.reject(err);
    await new Promise((res) => setTimeout(res, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
  });
});

describe('persistProjectReorder (P4-D3)', () => {
  it('maps the swapped list to a sort_order=100*i payload and calls bulkUpdateProjects', async () => {
    const d = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();

    persistProjectReorder([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], 'org-1');

    expect(bulkUpdateProjects).toHaveBeenCalledTimes(1);
    expect(bulkUpdateProjects).toHaveBeenCalledWith([
      { id: 'p1', changes: { sort_order: 0 } },
      { id: 'p2', changes: { sort_order: 100 } },
      { id: 'p3', changes: { sort_order: 200 } },
    ]);
    d.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    // ADR-018 — projects are tenant-less; refresh with empty params.
    expect(refreshShapeSource).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'projects_test' }),
      {}
    );
  });

  it('refreshes the PROJECTS_SHAPE on success and on failure (no double-refresh)', async () => {
    // Success path.
    const dOk = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(dOk.promise);
    refreshShapeSource.mockReset();
    persistProjectReorder([{ id: 'p1' }, { id: 'p2' }]);
    dOk.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);

    // Failure path.
    const dFail = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(dFail.promise);
    refreshShapeSource.mockReset();
    const onError = vi.fn();
    const onSettled = vi.fn();
    persistProjectReorder([{ id: 'p1' }, { id: 'p2' }], {
      onError,
      onSettled,
    });
    dFail.reject(new Error('bulk failed'));
    await new Promise((res) => setTimeout(res, 0));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
  });

  it('forwards onSettled for both success and failure (matches persistIssues contract)', async () => {
    const dOk = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(dOk.promise);
    refreshShapeSource.mockReset();
    const okSettled = vi.fn();
    persistProjectReorder([{ id: 'p1' }], { onSettled: okSettled });
    dOk.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(okSettled).toHaveBeenCalledTimes(1);

    const dFail = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(dFail.promise);
    refreshShapeSource.mockReset();
    const failSettled = vi.fn();
    persistProjectReorder([{ id: 'p1' }], {
      onSettled: failSettled,
    });
    dFail.reject(new Error('bulk failed'));
    await new Promise((res) => setTimeout(res, 0));
    expect(failSettled).toHaveBeenCalledTimes(1);
  });

  it('treats refresh failure as non-fatal (no onError, no double refresh)', async () => {
    const d = deferred<void>();
    bulkUpdateProjects.mockReset();
    bulkUpdateProjects.mockReturnValueOnce(d.promise);
    refreshShapeSource.mockReset();
    refreshShapeSource.mockImplementationOnce(() => {
      throw new Error('refresh kaboom');
    });
    const onError = vi.fn();
    const onSettled = vi.fn();
    persistProjectReorder([{ id: 'p1' }], { onError, onSettled });
    d.resolve();
    await new Promise((res) => setTimeout(res, 0));
    expect(onError).not.toHaveBeenCalled();
    expect(refreshShapeSource).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
