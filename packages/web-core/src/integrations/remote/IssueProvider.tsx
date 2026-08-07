import { useMemo, useCallback, type ReactNode } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  ISSUE_COMMENTS_SHAPE,
  ISSUE_COMMENT_MUTATION,
  type IssueComment,
} from 'shared/remote-types';
import {
  IssueContext,
  type IssueContextValue,
} from '@/shared/hooks/useIssueContext';

interface IssueProviderProps {
  issueId: string;
  children: ReactNode;
}

export function IssueProvider({ issueId, children }: IssueProviderProps) {
  const params = useMemo(() => ({ issue_id: issueId }), [issueId]);
  const enabled = Boolean(issueId);

  // Shape subscriptions
  const commentsResult = useShape(ISSUE_COMMENTS_SHAPE, params, {
    enabled,
    mutation: ISSUE_COMMENT_MUTATION,
  });

  // Combined loading state
  const isLoading = commentsResult.isLoading;

  // First error found
  const error = commentsResult.error || null;

  // Combined retry
  const retry = useCallback(() => {
    commentsResult.retry();
  }, [commentsResult]);

  // Computed Maps for O(1) lookup
  const commentsById = useMemo(() => {
    const map = new Map<string, IssueComment>();
    for (const comment of commentsResult.data) {
      map.set(comment.id, comment);
    }
    return map;
  }, [commentsResult.data]);

  // Lookup helpers
  const getComment = useCallback(
    (commentId: string) => commentsById.get(commentId),
    [commentsById]
  );

  const value = useMemo<IssueContextValue>(
    () => ({
      issueId,

      // Data
      comments: commentsResult.data,

      // Loading/error
      isLoading,
      error,
      retry,

      // Comment mutations
      insertComment: commentsResult.insert,
      updateComment: commentsResult.update,
      removeComment: commentsResult.remove,

      // Lookup helpers
      getComment,

      // Computed aggregations
      commentsById,
    }),
    [issueId, commentsResult, isLoading, error, retry, getComment, commentsById]
  );

  return (
    <IssueContext.Provider value={value}>{children}</IssueContext.Provider>
  );
}
