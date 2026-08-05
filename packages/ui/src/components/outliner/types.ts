import type { CSSProperties, Ref } from 'react';
import type { NodeApi } from 'react-arborist';
import type { Issue, IssuePriority, ProjectStatus } from 'shared/remote-types';
import type { WorkspaceKind } from 'shared/types';
import type { WorkspaceStatusItem } from '@vibe/ui/lib/workspaceStatus';
import { type BucketId } from '../../lib/buckets';

/** Minimal props every react-arborist node renderer receives. */
export interface TreeNodeRenderProps<T extends { id: string }> {
  node: NodeApi<T>;
  style: CSSProperties;
  dragHandle?: Ref<HTMLDivElement>;
}

/**
 * Kanban data for one project's Tasks section (ADR-011). Single source of
 * truth shared by the pure tree builder (packages/ui) and the lazy loader
 * hook (packages/web-core imports this from @vibe/ui — never the reverse).
 */
export interface ProjectTasksData {
  statuses: readonly ProjectStatus[];
  issues: readonly Issue[];
}

/** A single workspace rendered as a leaf in a workspaces tree. */
export interface OutlinerWorkspace extends WorkspaceStatusItem {
  name: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  kind?: WorkspaceKind | null;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessStatus?: 'running' | 'completed' | 'failed' | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
}

export type WorkspaceProjectMembership = Map<string, Set<string>>;

/** Bucket row in an outliner tree. `id` is the react-arborist node id (must
 * be unique across the tree), `bucketId` is the semantic bucket (used to
 * look up persisted open/closed state).
 */
export interface BucketNode {
  id: string;
  type: 'bucket';
  bucketId: BucketId;
  name: string;
  children: LeafNode[];
}

export interface LeafNode {
  id: string;
  type: 'leaf';
  workspace: OutlinerWorkspace;
}

export type OutlinerData = BucketNode | LeafNode;

// --- Sidebar tree node model ---------------------------------------------
//
// The 4-level node union of the global sidebar tree (ADR-007). Lives here
// (not in SidebarProjectTree.tsx) so the node renderers in treeNodes.tsx can
// import it without a runtime circular dependency on the tree component.

/** Stable id for the pseudo-project that holds workspaces with no project link. */
export const UNASSIGNED_PROJECT_ID = 'unassigned';

/** Per-project workspaces section id (e.g. `${projectId}:workspaces`). */
export type WorkspacesSectionId = `${string}:workspaces`;

/** Per-project Tasks section id (e.g. `${projectId}:tasks`). */
export type TasksSectionId = `${string}:tasks`;

/**
 * Sidebar project record (a trimmed shape — only what the tree needs to
 * render a project row).
 */
export interface SidebarProject {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
}

export interface ProjectNode {
  id: string;
  type: 'project';
  name: string;
  color: string;
  parentId: string | null;
  sortOrder: number;
  children: (SectionNode | ProjectNode)[];
}

/**
 * Section nodes carry a `kind` so the router can split Tasks vs Workspaces
 * (Phase 2). The `type` discriminator stays `'section'` for both.
 */
export interface WorkspacesSectionNode {
  id: WorkspacesSectionId;
  type: 'section';
  kind: 'workspaces';
  label: string;
  children: BucketNode[];
}

export interface TasksSectionNode {
  id: TasksSectionId;
  type: 'section';
  kind: 'tasks';
  /** Project id echoed so the renderer can fire onTasksExpansionChange(id, open)
   *  without walking to the parent. */
  projectId: string;
  label: string;
  /** True on first open, while statuses+issues are still loading. */
  isLoading?: boolean;
  children: StatusNode[];
}

/** Discriminate sections by `kind` (NOT by `type`, which stays 'section'). */
export type SectionNode = WorkspacesSectionNode | TasksSectionNode;

export interface StatusNode {
  id: string; // `${projectId}:status:${statusId}`
  type: 'status';
  projectId: string;
  statusId: string;
  name: string;
  color: string; // hsl triple string from ProjectStatus.color
  children: CardNode[];
}

/**
 * Issue card. Recursive: sub-issues (parent_issue_id) nest under their parent
 * card as `children`. Trimmed payload — only what the sidebar card needs.
 */
export interface CardNode {
  id: string; // `${projectId}:card:${issueId}` (project-scoped so open-state GC keeps it)
  type: 'card';
  issue: {
    id: string;
    title: string;
    priority: IssuePriority | null;
    statusId: string;
    projectId: string;
    parentIssueId: string | null;
  };
  children: CardNode[];
}

export type SidebarTreeNode =
  | ProjectNode
  | SectionNode
  | BucketNode
  | StatusNode
  | CardNode
  | LeafNode;

// --- id factories (moved here from SidebarProjectTree.tsx so the open-state
//     builder in this same file can use them) ---
export const makeWorkspacesSectionId = (
  projectId: string
): WorkspacesSectionId => `${projectId}:workspaces`;
export const makeTasksSectionId = (projectId: string): TasksSectionId =>
  `${projectId}:tasks`;
export const makeStatusNodeId = (projectId: string, statusId: string): string =>
  `${projectId}:status:${statusId}`;
export const makeCardNodeId = (projectId: string, issueId: string): string =>
  `${projectId}:card:${issueId}`;
