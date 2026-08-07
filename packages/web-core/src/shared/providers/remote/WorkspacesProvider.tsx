import { useMemo, useCallback, type ReactNode } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import { WORKSPACES_SHAPE } from 'shared/remote-types';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  WorkspacesContext,
  type WorkspacesContextValue,
} from '@/shared/hooks/useWorkspacesContext';

interface WorkspacesProviderProps {
  children: ReactNode;
}

export function WorkspacesProvider({ children }: WorkspacesProviderProps) {
  const { isSignedIn } = useAuth();

  // ADR-019: the User entity has been excised; the workspace shape has no
  // params (it was previously parametrised by `owner_user_id`, but that
  // column has been removed from the wire contract).
  const params = useMemo(() => ({}), []);
  const enabled = isSignedIn;

  // Shape subscriptions
  const workspacesResult = useShape(WORKSPACES_SHAPE, params, { enabled });

  // Lookup helpers
  const getWorkspacesForIssue = useCallback(
    (issueId: string) => {
      return workspacesResult.data.filter((w) => w.issue_id === issueId);
    },
    [workspacesResult.data]
  );

  const value = useMemo<WorkspacesContextValue>(
    () => ({
      // Data
      workspaces: workspacesResult.data,

      // Loading/error
      isLoading: workspacesResult.isLoading,
      error: workspacesResult.error,
      retry: workspacesResult.retry,

      // Lookup helpers
      getWorkspacesForIssue,
    }),
    [workspacesResult, getWorkspacesForIssue]
  );

  return (
    <WorkspacesContext.Provider value={value}>
      {children}
    </WorkspacesContext.Provider>
  );
}
