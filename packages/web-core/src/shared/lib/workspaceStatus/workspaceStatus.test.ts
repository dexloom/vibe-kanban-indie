import { describe, expect, it } from 'vitest';
import {
  categorizeWorkspacesForDashboard,
  categorizeWorkspacesForOutliner,
  compareWorkspaceDashboardRecency,
  computeWorkspaceBadgeCounts,
  isWorkspaceIdle,
  isWorkspaceNeedsAttention,
  isWorkspaceRunning,
  pickChatDestination,
  type WorkspaceStatusItem,
} from './workspaceStatus';

const ws = (overrides: Partial<WorkspaceStatusItem> & { id: string }): WorkspaceStatusItem => ({
  isRunning: false,
  hasPendingApproval: false,
  hasUnseenActivity: false,
  latestProcessCompletedAt: undefined,
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('workspace status', () => {
  it('classifies attention, running, idle', () => {
    expect(isWorkspaceNeedsAttention(ws({ id: 'a', hasPendingApproval: true }))).toBe(true);
    expect(isWorkspaceNeedsAttention(ws({ id: 'b', hasUnseenActivity: true }))).toBe(true);
    expect(isWorkspaceNeedsAttention(ws({ id: 'c', hasUnseenActivity: true, isRunning: true }))).toBe(false);
    expect(isWorkspaceNeedsAttention(ws({ id: 'd' }))).toBe(false);
    expect(isWorkspaceNeedsAttention(ws({ id: 'e', hasPendingApproval: true, hasUnseenActivity: true }))).toBe(true);
    expect(isWorkspaceRunning(ws({ id: 'f', isRunning: true }))).toBe(true);
    expect(isWorkspaceRunning(ws({ id: 'g', isRunning: true, hasPendingApproval: true }))).toBe(false);
    expect(isWorkspaceIdle(ws({ id: 'h' }))).toBe(true);
    expect(isWorkspaceIdle(ws({ id: 'i', isRunning: true }))).toBe(false);
    expect(isWorkspaceIdle(ws({ id: 'j', hasUnseenActivity: true }))).toBe(false);
  });

  it('sorts recency deterministically', () => {
    const a = ws({ id: 'a', latestProcessCompletedAt: '2024-01-01', createdAt: '2024-01-03' });
    const b = ws({ id: 'b', latestProcessCompletedAt: '2024-01-02', createdAt: '2024-01-01' });
    expect(compareWorkspaceDashboardRecency(a, b)).toBeGreaterThan(0);
    expect(compareWorkspaceDashboardRecency(ws({ id: 'a', createdAt: '2024-01-01' }), ws({ id: 'b', createdAt: '2024-01-01' }))).toBeGreaterThan(0);
    expect(compareWorkspaceDashboardRecency(ws({ id: 'a' }), ws({ id: 'b' }))).toBeGreaterThan(0);

    const older = ws({ id: 'older', createdAt: '2024-01-01' });
    const newer = ws({ id: 'newer', createdAt: '2024-01-02' });
    expect([older, newer].sort(compareWorkspaceDashboardRecency)).toEqual([newer, older]);
  });

  it('uses createdAt as tiebreaker within dashboard buckets', () => {
    const attentionOlder = ws({ id: 'a', hasPendingApproval: true, createdAt: '2024-01-01' });
    const attentionNewer = ws({ id: 'b', hasPendingApproval: true, createdAt: '2024-01-02' });
    const runningOlder = ws({ id: 'c', isRunning: true, createdAt: '2024-01-01' });
    const runningNewer = ws({ id: 'd', isRunning: true, createdAt: '2024-01-02' });
    const categories = categorizeWorkspacesForDashboard([
      attentionOlder,
      attentionNewer,
      runningOlder,
      runningNewer,
    ]);

    expect(categories.needsAttention.map((w) => w.id)).toEqual(['b', 'a']);
    expect(categories.running.map((w) => w.id)).toEqual(['d', 'c']);
  });

  it('categorizes and picks destinations', () => {
    const items = [ws({ id: 'idle', latestProcessCompletedAt: '2024-01-05' }), ws({ id: 'run', isRunning: true }), ws({ id: 'attn', hasPendingApproval: true })];
    const categories = categorizeWorkspacesForDashboard(items);
    expect(categories.needsAttention.map((x) => x.id)).toEqual(['attn']);
    expect(categories.running.map((x) => x.id)).toEqual(['run']);
    expect(categories.idle.map((x) => x.id)).toEqual(['idle']);
    expect(pickChatDestination([])).toEqual({ kind: 'workspaces-create' });
    expect(pickChatDestination(items)).toEqual({ kind: 'workspace', workspaceId: 'attn' });
    expect(pickChatDestination(items.slice().reverse())).toEqual(pickChatDestination(items));
  });

  it('computes badge counts from effective status', () => {
    expect(computeWorkspaceBadgeCounts([])).toEqual({ runningCount: 0, needsAttentionCount: 0 });
    expect(computeWorkspaceBadgeCounts([ws({ id: 'a', isRunning: true }), ws({ id: 'b', isRunning: true, hasPendingApproval: true })])).toEqual({ runningCount: 1, needsAttentionCount: 1 });
  });

  describe('categorizeWorkspacesForOutliner', () => {
    it('returns empty buckets for empty input', () => {
      const result = categorizeWorkspacesForOutliner([], []);
      expect(result).toEqual({
        attention: [],
        running: [],
        idle: [],
        archived: [],
      });
    });

    it('partitions the four buckets without overlap or loss', () => {
      const attn = ws({ id: 'attn-1', hasPendingApproval: true });
      const running = ws({ id: 'run-1', isRunning: true });
      const idle = ws({ id: 'idle-1', latestProcessCompletedAt: '2024-01-05' });
      const attn2 = ws({ id: 'attn-2', hasUnseenActivity: true });
      const archivedA = ws({ id: 'arch-1' });
      const archivedB = ws({ id: 'arch-2' });

      const result = categorizeWorkspacesForOutliner(
        [attn, running, idle, attn2],
        [archivedA, archivedB]
      );

      expect(result.attention.map((w) => w.id)).toEqual(['attn-1', 'attn-2']);
      expect(result.running.map((w) => w.id)).toEqual(['run-1']);
      expect(result.idle.map((w) => w.id)).toEqual(['idle-1']);
      expect(result.archived.map((w) => w.id)).toEqual(['arch-1', 'arch-2']);
    });

    it('preserves input order within each bucket', () => {
      const items = [
        ws({ id: 'attn-b', hasPendingApproval: true }),
        ws({ id: 'attn-a', hasPendingApproval: true }),
        ws({ id: 'attn-c', hasPendingApproval: true }),
      ];
      const result = categorizeWorkspacesForOutliner(items, []);
      expect(result.attention.map((w) => w.id)).toEqual(['attn-b', 'attn-a', 'attn-c']);
    });

    it('passes archived workspaces through unchanged (no filter)', () => {
      const runningArchived = ws({ id: 'arch-run', isRunning: true });
      const result = categorizeWorkspacesForOutliner([], [runningArchived]);
      expect(result.archived.map((w) => w.id)).toEqual(['arch-run']);
    });
  });
});