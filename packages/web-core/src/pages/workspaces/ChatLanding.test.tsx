import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = {
  goToWorkspace: vi.fn(),
  goToWorkspacesCreate: vi.fn(),
};

let workspaceContext = {
  activeWorkspaces: [] as Array<{ id: string; createdAt: string; hasPendingApproval?: boolean }>,
  isWorkspacesListLoading: true,
};

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useEffect: (effect: () => void) => effect(),
  };
});

vi.mock('@phosphor-icons/react', () => ({
  SpinnerIcon: () => null,
}));

vi.mock('@/shared/hooks/useAppNavigation', () => ({
  useAppNavigation: () => navigation,
}));

vi.mock('@/shared/hooks/useWorkspaceContext', () => ({
  useWorkspaceContext: () => workspaceContext,
}));

import { ChatLanding } from './ChatLanding';

describe('ChatLanding', () => {
  beforeEach(() => {
    navigation.goToWorkspace.mockReset();
    navigation.goToWorkspacesCreate.mockReset();
    workspaceContext = {
      activeWorkspaces: [],
      isWorkspacesListLoading: true,
    };
  });

  it('renders without crashing and does not navigate while loading', () => {
    expect(ChatLanding()).toBeTruthy();
    expect(navigation.goToWorkspace).not.toHaveBeenCalled();
    expect(navigation.goToWorkspacesCreate).not.toHaveBeenCalled();
  });

  it('navigates to workspace creation after loading finishes with no workspaces', () => {
    ChatLanding();
    workspaceContext = { ...workspaceContext, isWorkspacesListLoading: false };
    ChatLanding();

    expect(navigation.goToWorkspacesCreate).toHaveBeenCalledWith({ replace: true });
    expect(navigation.goToWorkspace).not.toHaveBeenCalled();
  });

  it('navigates to needs-attention workspace after loading finishes', () => {
    workspaceContext = {
      activeWorkspaces: [
        { id: 'workspace-1', createdAt: '2024-01-01', hasPendingApproval: true },
      ],
      isWorkspacesListLoading: true,
    };
    ChatLanding();
    workspaceContext = { ...workspaceContext, isWorkspacesListLoading: false };
    ChatLanding();

    expect(navigation.goToWorkspace).toHaveBeenCalledWith('workspace-1', { replace: true });
    expect(navigation.goToWorkspacesCreate).not.toHaveBeenCalled();
  });
});
