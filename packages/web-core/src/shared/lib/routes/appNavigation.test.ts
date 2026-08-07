import { describe, expect, it } from 'vitest';
import {
  isLocalWorkspacesDestination,
  isProjectDestination,
  isWorkspaceChatDestination,
  isWorkspacesDashboardDestination,
  resolveKanbanRouteState,
} from './appNavigation';

describe('workspace navigation predicates', () => {
  it('identifies dashboard only', () => {
    expect(isWorkspacesDashboardDestination({ kind: 'workspaces' })).toBe(true);
    for (const value of [
      { kind: 'workspaces-create' },
      { kind: 'workspace', workspaceId: 'x' },
      { kind: 'workspace-vscode', workspaceId: 'x' },
      { kind: 'chat' },
      { kind: 'project', projectId: 'x' },
      null,
    ] as const)
      expect(isWorkspacesDashboardDestination(value)).toBe(false);
  });
  it('identifies chat destinations', () => {
    expect(isWorkspaceChatDestination({ kind: 'chat' })).toBe(true);
    expect(
      isWorkspaceChatDestination({ kind: 'workspace', workspaceId: 'x' })
    ).toBe(true);
    for (const value of [
      { kind: 'workspaces-create' },
      { kind: 'workspaces' },
      { kind: 'workspace-vscode', workspaceId: 'x' },
      { kind: 'project', projectId: 'x' },
      null,
    ] as const)
      expect(isWorkspaceChatDestination(value)).toBe(false);
  });
  it('identifies local workspace routes', () => {
    for (const value of [
      { kind: 'workspaces' },
      { kind: 'workspaces-create' },
      { kind: 'workspace', workspaceId: 'x' },
      { kind: 'workspace-vscode', workspaceId: 'x' },
    ] as const)
      expect(isLocalWorkspacesDestination(value)).toBe(true);
    expect(isLocalWorkspacesDestination({ kind: 'chat' })).toBe(false);
    expect(
      isLocalWorkspacesDestination({
        kind: 'workspace',
        workspaceId: 'x',
        hostId: 'h',
      })
    ).toBe(false);
  });
});

describe('ADR-016 orchestrator-prompt destination', () => {
  it('is classified as a project destination', () => {
    expect(
      isProjectDestination({
        kind: 'project-orchestrator-prompt',
        projectId: 'p-1',
      })
    ).toBe(true);
  });

  it('resolveKanbanRouteState maps to projectId with sidebarMode: closed', () => {
    // ADR-016: the editor IS the page — not a kanban side panel. No
    // issue/workspace/draft, but the projectId is set so the tree's
    // active row highlighting still works.
    const state = resolveKanbanRouteState({
      kind: 'project-orchestrator-prompt',
      projectId: 'p-1',
    });
    expect(state.projectId).toBe('p-1');
    expect(state.issueId).toBeNull();
    expect(state.workspaceId).toBeNull();
    expect(state.draftId).toBeNull();
    expect(state.sidebarMode).toBe('closed');
    expect(state.isPanelOpen).toBe(false);
    expect(state.isCreateMode).toBe(false);
    expect(state.isWorkspaceCreateMode).toBe(false);
  });
});
