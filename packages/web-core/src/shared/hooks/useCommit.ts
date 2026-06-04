import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/shared/lib/api';
import { repoBranchKeys } from '@/shared/hooks/useRepoBranches';
import type { CommitWorkspaceResponse } from 'shared/types';

type CommitParams = {
  repoId: string;
};

export function useCommit(
  workspaceId?: string,
  onSuccess?: (result: CommitWorkspaceResponse) => void,
  onError?: (err: unknown) => void
) {
  const queryClient = useQueryClient();

  return useMutation<CommitWorkspaceResponse, unknown, CommitParams>({
    mutationFn: (params: CommitParams) => {
      if (!workspaceId) return Promise.resolve({ committed: false });
      return workspacesApi.commit(workspaceId, {
        repo_id: params.repoId,
      });
    },
    onSuccess: (result) => {
      // A commit changes uncommitted state and commits_ahead; refresh the
      // branch status (backing has_uncommitted_changes / uncommitted_count)
      // and repo branches.
      queryClient.invalidateQueries({
        queryKey: ['branchStatus', workspaceId],
      });
      queryClient.invalidateQueries({ queryKey: repoBranchKeys.all });

      onSuccess?.(result);
    },
    onError: (err) => {
      console.error('Failed to commit:', err);
      onError?.(err);
    },
  });
}
