import { useMemo } from 'react';
import { useLocation } from '@tanstack/react-router';
import { useCurrentAppDestination } from '@/shared/hooks/useCurrentAppDestination';
import {
  resolveKanbanRouteState,
  type KanbanRouteState,
} from '@/shared/lib/routes/appNavigation';
import {
  buildKanbanIssueComposerKey,
  useKanbanIssueComposer,
} from '@/shared/stores/useKanbanIssueComposerStore';

export function useCurrentKanbanRouteState(): KanbanRouteState {
  const destination = useCurrentAppDestination();
  const location = useLocation();
  const routeState = useMemo(
    () => resolveKanbanRouteState(destination),
    [destination]
  );
  // Sub-issue board: the optional `?issue=` search param selects one child so
  // its panel opens directly. The destination (path-derived) only carries the
  // parent filter; the selected child lives in the search param and is merged
  // in here so the kanban treats it as the open issue.
  const subBoardSelectedIssue =
    (location.search as { issue?: string } | undefined)?.issue ?? null;
  const issueComposerKey = useMemo(() => {
    if (!routeState.projectId) {
      return null;
    }

    return buildKanbanIssueComposerKey(routeState.hostId, routeState.projectId);
  }, [routeState.hostId, routeState.projectId]);
  const issueComposer = useKanbanIssueComposer(issueComposerKey);
  const isCreateMode = issueComposer !== null;

  return useMemo(() => {
    const withSelection: KanbanRouteState =
      routeState.parentIssueId && subBoardSelectedIssue
        ? {
            ...routeState,
            issueId: subBoardSelectedIssue,
            sidebarMode: 'issue',
            // resolveKanbanRouteState returns isPanelOpen:false for the
            // sub-board; opening a child's panel via ?issue= must flip it.
            isPanelOpen: true,
          }
        : routeState;
    return {
      ...withSelection,
      isCreateMode,
      isPanelOpen: withSelection.isPanelOpen || isCreateMode,
    };
  }, [routeState, subBoardSelectedIssue, isCreateMode]);
}
