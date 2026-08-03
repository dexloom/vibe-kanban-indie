import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutlinerWorkspace } from './outliner/types';
import { SidebarBucketBar } from './SidebarBucketBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'workspaces.bucketBarLabel': 'Workspace buckets',
          'workspaces.bucketEmpty': 'No workspaces',
          'workspaces.outliner.attention': 'Attention',
          'workspaces.running': 'Running',
          'workspaces.idle': 'Idle',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

afterEach(cleanup);

function workspace(
  id: string,
  overrides: Partial<OutlinerWorkspace> = {},
): OutlinerWorkspace {
  return {
    id,
    name: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderBar(
  workspaces: readonly OutlinerWorkspace[],
  activeWorkspaceId: string | null = null,
  onSelectWorkspace = vi.fn(),
) {
  return render(
    <SidebarBucketBar
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      onSelectWorkspace={onSelectWorkspace}
    />,
  );
}

function openBucket(name: RegExp) {
  fireEvent.pointerDown(screen.getByRole('button', { name }), {
    button: 0,
    ctrlKey: false,
  });
}

describe('SidebarBucketBar', () => {
  it('renders all three buttons without badges when empty', () => {
    renderBar([]);

    const toolbar = screen.getByRole('toolbar', {
      name: 'Workspace buckets',
    });
    expect(within(toolbar).getAllByRole('button')).toHaveLength(3);
    expect(toolbar.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(
      0,
    );
  });

  it('shows badge counts for predicate-partitioned workspaces', () => {
    renderBar([
      workspace('approval', { hasPendingApproval: true }),
      workspace('unseen', { hasUnseenActivity: true }),
      workspace('running', { isRunning: true }),
      workspace('idle'),
    ]);

    expect(
      within(screen.getByRole('button', { name: 'Attention — 2' })).getByText(
        '2',
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'Running — 1' })).getByText(
        '1',
      ),
    ).toBeTruthy();
    // Idle hides its badge (owner: counts there are noise), so the button's
    // accessible name is just the visible label and it has no badge text.
    const idleButton = screen.getByRole('button', { name: 'Idle' });
    expect(idleButton.getAttribute('aria-label')).toBeNull();
    expect(idleButton.textContent).not.toContain('1');
  });

  it('orders dropdown items newest-first', async () => {
    renderBar([
      workspace('Older', {
        hasPendingApproval: true,
        latestProcessCompletedAt: '2026-08-01T00:00:00.000Z',
      }),
      workspace('Newest', {
        hasPendingApproval: true,
        latestProcessCompletedAt: '2026-08-03T00:00:00.000Z',
      }),
    ]);

    openBucket(/Attention/);

    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.includes('Newest'))).toEqual([
      true,
      false,
    ]);
  });

  it('selects a workspace and closes the menu', async () => {
    const onSelectWorkspace = vi.fn();
    renderBar(
      [workspace('Selected', { hasPendingApproval: true })],
      null,
      onSelectWorkspace,
    );

    openBucket(/Attention/);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Selected/ }));

    expect(onSelectWorkspace).toHaveBeenCalledWith('Selected');
    await waitFor(() => {
      expect(screen.queryByRole('menuitem')).toBeNull();
    });
  });

  it('marks the active workspace item as current', async () => {
    renderBar([workspace('Active', { isRunning: true })], 'Active');

    openBucket(/Running/);

    expect(
      (await screen.findByRole('menuitem', { name: /Active/ })).getAttribute(
        'aria-current',
      ),
    ).toBe('page');
  });

  it('exposes toolbar semantics and label', () => {
    renderBar([]);

    expect(
      screen.getByRole('toolbar', { name: 'Workspace buckets' }),
    ).toBeTruthy();
  });
});
