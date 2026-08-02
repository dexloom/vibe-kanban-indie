import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import type { CreateAndStartWorkspaceRequest } from 'shared/types';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { PROJECT_WORKSPACES_SHAPE } from 'shared/remote-types';
import { refreshShapeSource } from '@/shared/lib/electric/collections';

interface CreateWorkspaceParams {
  data: CreateAndStartWorkspaceRequest;
  linkToIssue?: {
    remoteProjectId: string;
    issueId: string;
  };
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();

  const createWorkspace = useMutation({
    mutationFn: async ({ data, linkToIssue }: CreateWorkspaceParams) => {
      const { workspace } = await workspacesApi.createAndStart(data);

      if (linkToIssue && workspace) {
        try {
          await workspacesApi.linkToIssue(
            workspace.id,
            linkToIssue.remoteProjectId,
            linkToIssue.issueId
          );
          // The new workspace↔issue link only surfaces through the workspaces
          // shape, which the local build polls on a slow interval. Force a
          // refresh so the kanban card shows the workspace immediately.
          refreshShapeSource(PROJECT_WORKSPACES_SHAPE, {
            project_id: linkToIssue.remoteProjectId,
          });
        } catch (linkError) {
          console.error('Failed to link workspace to issue:', linkError);
        }
      }

      return { workspace };
    },
    onSuccess: () => {
      // Invalidate workspace summaries so they refresh with the new workspace included
      queryClient.invalidateQueries({ queryKey: workspaceSummaryKeys.all });
      // Ensure create-mode defaults refetch the latest session/model selection.
      queryClient.invalidateQueries({ queryKey: ['workspaceCreateDefaults'] });
    },
    onError: (err) => {
      console.error('Failed to create workspace:', err);
    },
  });

  return { createWorkspace };
}
