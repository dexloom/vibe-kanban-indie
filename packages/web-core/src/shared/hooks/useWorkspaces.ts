import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useJsonPatchWsStream } from '@/shared/hooks/useJsonPatchWsStream';
import { workspaceSummaryKeys } from '@/shared/hooks/workspaceSummaryKeys';
import { makeLocalApiRequest } from '@/shared/lib/localApiTransport';
import { useHostId } from '@/shared/providers/HostIdProvider';
import type {
  WorkspaceWithStatus,
  WorkspaceKind,
  WorkspaceSummary,
  WorkspaceSummaryResponse,
  ApiResponse,
} from 'shared/types';

// UI-specific workspace type for sidebar display
export interface SidebarWorkspace {
  id: string;
  name: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  description: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  kind?: WorkspaceKind | null;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessCompletedAt?: string;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
  prNumber?: number;
  prUrl?: string;
}

// Keep the old export name for backwards compatibility
export type Workspace = SidebarWorkspace;

export interface UseWorkspacesResult {
  workspaces: SidebarWorkspace[];
  archivedWorkspaces: SidebarWorkspace[];
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

// State shape from the WebSocket stream
type WorkspacesState = {
  workspaces: Record<string, WorkspaceWithStatus>;
};

// Transform WorkspaceWithStatus to SidebarWorkspace, optionally merging summary data
function toSidebarWorkspace(
  ws: WorkspaceWithStatus,
  summary?: WorkspaceSummary
): SidebarWorkspace {
  return {
    id: ws.id,
    name: ws.name ?? ws.branch, // Use name if available, fallback to branch
    branch: ws.branch,
    createdAt: ws.created_at,
    updatedAt: ws.updated_at,
    description: '',
    // Use real stats from summary if available
    filesChanged: summary?.files_changed ?? undefined,
    linesAdded: summary?.lines_added ?? undefined,
    linesRemoved: summary?.lines_removed ?? undefined,
    // Real data from stream
    isRunning: ws.is_running,
    isPinned: ws.pinned,
    isArchived: ws.archived,
    kind: ws.kind,
    // Additional data from summary
    hasPendingApproval: summary?.has_pending_approval,
    hasRunningDevServer: summary?.has_running_dev_server,
    hasUnseenActivity: summary?.has_unseen_turns,
    latestProcessCompletedAt: summary?.latest_process_completed_at ?? undefined,
    latestProcessStatus: summary?.latest_process_status ?? undefined,
    prStatus: summary?.pr_status ?? undefined,
    prNumber:
      summary?.pr_number != null ? Number(summary.pr_number) : undefined,
    prUrl: summary?.pr_url ?? undefined,
  };
}

export const workspaceKeys = {
  all: ['workspaces'] as const,
};

// workspaceSummaryKeys is imported from @/shared/hooks/workspaceSummaryKeys

// Fetch workspace summaries from the API by archived status
async function fetchWorkspaceSummariesByArchived(
  archived: boolean,
  hostId: string | null
): Promise<Map<string, WorkspaceSummary>> {
  try {
    const basePath = hostId ? `/api/host/${hostId}` : '/api';
    const response = await makeLocalApiRequest(
      `${basePath}/workspaces/summaries`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      }
    );

    if (!response.ok) {
      console.warn('Failed to fetch workspace summaries:', response.status);
      return new Map();
    }

    const data: ApiResponse<WorkspaceSummaryResponse> = await response.json();
    if (!data.success || !data.data?.summaries) {
      return new Map();
    }

    const map = new Map<string, WorkspaceSummary>();
    for (const summary of data.data.summaries) {
      map.set(summary.workspace_id, summary);
    }
    return map;
  } catch (err) {
    console.warn('Error fetching workspace summaries:', err);
    return new Map();
  }
}

export function useWorkspaces(): UseWorkspacesResult {
  const hostId = useHostId();

  // Two separate WebSocket connections: one for active, one for archived
  // No limit param - we fetch all and slice on frontend so backfill works when archiving
  const apiBasePath = hostId ? `/api/host/${hostId}` : '/api';
  const activeEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=false`;
  const archivedEndpoint = `${apiBasePath}/workspaces/streams/ws?archived=true`;

  const initialData = useCallback(
    (): WorkspacesState => ({ workspaces: {} }),
    []
  );

  const {
    data: activeData,
    isConnected: activeIsConnected,
    isInitialized: activeIsInitialized,
    error: activeError,
  } = useJsonPatchWsStream<WorkspacesState>(activeEndpoint, true, initialData);

  const {
    data: archivedData,
    isConnected: archivedIsConnected,
    isInitialized: archivedIsInitialized,
    error: archivedError,
  } = useJsonPatchWsStream<WorkspacesState>(
    archivedEndpoint,
    true,
    initialData
  );

  // Wait for both streams to be initialized before fetching summaries
  // Fetch summaries for active workspaces
  const { data: activeSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(false, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(false, hostId),
      enabled: activeIsInitialized,
      staleTime: 1000,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      placeholderData: keepPreviousData,
    });

  // Fetch summaries for archived workspaces
  const { data: archivedSummaries = new Map<string, WorkspaceSummary>() } =
    useQuery({
      queryKey: workspaceSummaryKeys.byArchived(true, hostId),
      queryFn: () => fetchWorkspaceSummariesByArchived(true, hostId),
      enabled: archivedIsInitialized,
      staleTime: 1000,
      refetchInterval: 15000,
      refetchOnWindowFocus: false,
      refetchOnMount: 'always',
      placeholderData: keepPreviousData,
    });

  const activeList = useMemo(() => {
    if (!activeData?.workspaces) return [];
    return Object.values(activeData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) => toSidebarWorkspace(ws, activeSummaries.get(ws.id)));
  }, [activeData, activeSummaries]);

  const archivedList = useMemo(() => {
    if (!archivedData?.workspaces) return [];
    return Object.values(archivedData.workspaces)
      .sort((a, b) => {
        // First sort by pinned (pinned first)
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        // Then by created_at (newest first)
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      })
      .map((ws) => toSidebarWorkspace(ws, archivedSummaries.get(ws.id)));
  }, [archivedData, archivedSummaries]);

  // Coalesce the high-frequency workspace-status stream so the consumer tree
  // re-renders at most once per throttle window. `useWorkspaces` runs once at
  // the app root (WorkspaceProvider) and its result flows into WorkspaceContext,
  // so without coalescing every WebSocket JsonPatch (agent/orchestrator status
  // churn arrives in bursts) cascades a full-tree re-render — freezing heavy
  // panels (the kanban card right pane) and destabilizing local interaction
  // state (selections/checkboxes reverting mid-reconcile). Connection/error
  // state below is left unthrottled so it stays responsive.
  //
  // This mirrors the diff-stream rAF batching in WorkspaceProvider; a ~300ms
  // window is imperceptible for status indicators (the summary poll already
  // runs every 15s) while collapsing bursts into a single reconciled render.
  const COALESCE_MS = 300;
  const [lists, setLists] = useState({
    active: activeList,
    archived: archivedList,
  });
  const latestListsRef = useRef(lists);
  latestListsRef.current = { active: activeList, archived: archivedList };
  const flushTimerRef = useRef<number | null>(null);
  const lastFlushRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    // Leading edge: flush immediately once the window has elapsed so status
    // appears promptly.
    if (now - lastFlushRef.current >= COALESCE_MS) {
      lastFlushRef.current = now;
      setLists(latestListsRef.current);
      return;
    }
    // Trailing edge: collapse any further patches within the window into one
    // flush.
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = null;
        lastFlushRef.current = Date.now();
        setLists(latestListsRef.current);
      }, COALESCE_MS);
    }
  }, [activeList, archivedList]);

  useEffect(
    () => () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    },
    []
  );

  const workspaces = lists.active;
  const archivedWorkspaces = lists.archived;

  // isLoading is true when we haven't received initial data from either stream
  const isLoading = !activeIsInitialized || !archivedIsInitialized;

  // Combined connection status
  const isConnected = activeIsConnected && archivedIsConnected;

  // Combined error (show first error if any)
  const error = activeError || archivedError;

  return {
    workspaces,
    archivedWorkspaces,
    isLoading,
    isConnected,
    error,
  };
}
