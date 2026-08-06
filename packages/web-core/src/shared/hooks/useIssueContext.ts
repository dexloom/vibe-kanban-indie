import { useContext } from 'react';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type { InsertResult, MutationResult } from '@/shared/lib/electric/types';
import type {
  IssueComment,
  CreateIssueCommentRequest,
  UpdateIssueCommentRequest,
} from 'shared/remote-types';
import type { SyncError } from '@/shared/lib/electric/types';

/**
 * IssueContext provides issue-scoped data and mutations.
 *
 * ADR-019: comment-reaction entity excised (reactions no longer modelled —
 * single-developer fork has nobody else to react with).
 */
export interface IssueContextValue {
  issueId: string;

  // Normalized data arrays (Electric syncs only this issue's data)
  comments: IssueComment[];

  // Loading/error state
  isLoading: boolean;
  error: SyncError | null;
  retry: () => void;

  // Comment mutations
  insertComment: (
    data: CreateIssueCommentRequest
  ) => InsertResult<IssueComment>;
  updateComment: (
    id: string,
    changes: Partial<UpdateIssueCommentRequest>
  ) => MutationResult;
  removeComment: (id: string) => MutationResult;

  // Lookup helpers (within this issue's data)
  getComment: (commentId: string) => IssueComment | undefined;

  // Computed aggregations
  commentsById: Map<string, IssueComment>;
}

export const IssueContext = createHmrContext<IssueContextValue | null>(
  'IssueContext',
  null
);

export function useIssueContext(): IssueContextValue {
  const context = useContext(IssueContext);
  if (!context) {
    throw new Error('useIssueContext must be used within an IssueProvider');
  }
  return context;
}

export function useIssueContextOptional(): IssueContextValue | null {
  return useContext(IssueContext);
}
