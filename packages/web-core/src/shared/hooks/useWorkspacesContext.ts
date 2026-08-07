import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { Workspace } from 'shared/remote-types';
import type { SyncError } from '@/shared/lib/electric/types';

/**
 * WorkspacesContext provides the workspace list (all linked workspaces; in
 * the single-developer fork there's only one user, so the shape is unfiltered).
 *
 * ADR-019: this used to be `UserContext` — the name was misleading once the
 * User entity was excised. The data is just "all linked workspaces" with a
 * helper to filter by issue.
 */
export interface WorkspacesContextValue {
  // Data
  workspaces: Workspace[];

  // Loading/error state
  isLoading: boolean;
  error: SyncError | null;
  retry: () => void;

  // Lookup helpers
  getWorkspacesForIssue: (issueId: string) => Workspace[];
}

export const WorkspacesContext =
  createHmrContext<WorkspacesContextValue | null>('WorkspacesContext', null);

/**
 * Hook to access the workspaces context.
 * Must be used within a WorkspacesProvider.
 */
export function useWorkspacesContext(): WorkspacesContextValue {
  const context = useContext(WorkspacesContext);
  if (!context) {
    throw new Error(
      'useWorkspacesContext must be used within a WorkspacesProvider'
    );
  }
  return context;
}
