import { describe, expect, it } from 'vitest';
import {
  isLocalWorkspacesDestination,
  isWorkspaceChatDestination,
  isWorkspacesDashboardDestination,
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
