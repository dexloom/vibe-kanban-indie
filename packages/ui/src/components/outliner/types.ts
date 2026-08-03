import type { CSSProperties, Ref } from 'react';
import type { NodeApi } from 'react-arborist';
import type { WorkspaceKind } from 'shared/types';
import type { WorkspaceStatusItem } from '@vibe/ui/lib/workspaceStatus';

/** Minimal props every react-arborist node renderer receives. */
export interface TreeNodeRenderProps<T extends { id: string }> {
  node: NodeApi<T>;
  style: CSSProperties;
  dragHandle?: Ref<HTMLDivElement>;
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

/**
 * ADR-006 migration-only keys for first-run bucket open-state seeding.
 */
export const LEGACY_BUCKET_PERSIST_KEYS = {
  attention: 'workspaces-outliner-attention',
  running: 'workspaces-outliner-running',
  idle: 'workspaces-outliner-idle',
  archived: 'workspaces-outliner-archived',
} as const;

export type WorkspaceProjectMembership = Map<string, Set<string>>;

/** Semantic bucket id (storage key suffix, NOT a react-arborist node id). */
export type BucketId = keyof typeof LEGACY_BUCKET_PERSIST_KEYS;

export const BUCKET_ORDER: readonly BucketId[] = [
  'attention',
  'running',
  'idle',
  'archived',
] as const;

export const BUCKET_DEFAULT_OPEN: Record<BucketId, boolean> = {
  attention: true,
  running: true,
  idle: true,
  archived: false,
};

/**
 * Bucket row in an outliner tree. `id` is the react-arborist node id (must
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

/**
 * Sidebar project record (a trimmed shape — only what the tree needs to
 * render a project row).
 */
export interface SidebarProject {
  id: string;
  name: string;
  color: string;
}

export type SidebarTreeNode = ProjectNode | SectionNode | BucketNode | LeafNode;

export interface ProjectNode {
  id: string;
  type: 'project';
  name: string;
  color: string;
  children: SectionNode[];
}

export interface SectionNode {
  id: WorkspacesSectionId;
  type: 'section';
  label: string;
  children: BucketNode[];
}

/**
 * Read persisted open/closed state for each bucket from localStorage. Falls
 * back to the bucket defaults when nothing is stored yet (or storage is
 * unavailable). Safe to call during render.
 */
export function readLegacyBucketOpenState(): Record<BucketId, boolean> {
  const out = { ...BUCKET_DEFAULT_OPEN };
  if (typeof window === 'undefined') return out;
  try {
    for (const bucketId of Object.keys(
      LEGACY_BUCKET_PERSIST_KEYS,
    ) as BucketId[]) {
      const raw = window.localStorage.getItem(
        `vibe.ui.collapsible.${LEGACY_BUCKET_PERSIST_KEYS[bucketId]}`,
      );
      if (raw != null) {
        out[bucketId] = raw === 'true';
      }
    }
  } catch {
    // ignore storage failures (private mode / quota)
  }
  return out;
}

// --- Sidebar tree open-state persistence -------------------------------
//
// Persist expand/collapse state for SidebarProjectTree across sessions.
// One JSON blob maps node ids → booleans. Node ids already encode project
// scope (`<projectId>:bucket:<bucketId>`), so state is naturally
// per-project — no cross-project leakage, no key explosion.
//
// react-arborist reads `initialOpenState` exactly once (at Tree mount,
// inside provider.js `useRef(createStore(...))`). Post-mount, its in-memory
// redux store owns open state. This module only seeds the initial map and
// mirrors user toggles back to localStorage.

const SIDEBAR_TREE_OPEN_STATE_KEY = 'vibe.ui.sidebarTree.openState';
const SIDEBAR_TREE_OPEN_STATE_VERSION = 1;

/** Read the persisted open-state blob (or {} on miss / corruption). */
export function readSidebarTreeOpenState(
  liveProjectIds?: ReadonlySet<string>,
): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SIDEBAR_TREE_OPEN_STATE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    let state: Record<string, boolean>;
    if ('v' in parsed) {
      if (parsed.v !== SIDEBAR_TREE_OPEN_STATE_VERSION) return {};
      if (
        !('state' in parsed) ||
        !parsed.state ||
        typeof parsed.state !== 'object' ||
        Array.isArray(parsed.state)
      ) {
        return {};
      }
      state = parsed.state as Record<string, boolean>;
    } else {
      state = parsed as Record<string, boolean>;
    }

    if (!liveProjectIds || liveProjectIds.size === 0) return state;
    return Object.fromEntries(
      Object.entries(state).filter(([key]) => {
        const separatorIndex = key.indexOf(':');
        const projectId =
          separatorIndex === -1 ? key : key.slice(0, separatorIndex);
        return liveProjectIds.has(projectId);
      }),
    );
  } catch {
    // corrupt JSON | private mode | quota — fall through
  }
  return {};
}

/** Write the open-state blob. Ignores storage failures. */
export function writeSidebarTreeOpenState(map: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      SIDEBAR_TREE_OPEN_STATE_KEY,
      JSON.stringify({ v: SIDEBAR_TREE_OPEN_STATE_VERSION, state: map }),
    );
  } catch {
    // quota | unavailable — in-memory mirror still authoritative for session
  }
}

/**
 * Build the `initialOpenState` map for <Tree>. Per-node resolution:
 *   1. value persisted in the sidebar-tree blob
 *   2. legacy per-bucket value (buckets only, first-run migration)
 *   3. default: project & section = open; attention/running/idle = open;
 *      archived = closed (BUCKET_DEFAULT_OPEN).
 *
 * Only the value at Tree mount is consumed. Recomputing later is harmless
 * (Tree ignores the prop then).
 */
export function buildSidebarTreeInitialOpenState(
  projectIds: readonly string[],
): Record<string, boolean> {
  const stored = readSidebarTreeOpenState(new Set(projectIds));
  const useLegacy = Object.keys(stored).length === 0;
  const legacy: Partial<Record<BucketId, boolean>> = useLegacy
    ? readLegacyBucketOpenState()
    : {};
  const out: Record<string, boolean> = {};
  for (const projectId of projectIds) {
    out[projectId] = stored[projectId] ?? true;
    out[`${projectId}:workspaces`] = stored[`${projectId}:workspaces`] ?? true;
    for (const bucketId of BUCKET_ORDER) {
      const nodeId = `${projectId}:bucket:${bucketId}`;
      out[nodeId] =
        stored[nodeId] ?? legacy[bucketId] ?? BUCKET_DEFAULT_OPEN[bucketId];
    }
  }
  return out;
}

/** Compact Gmail-style relative time: "just now", "5m ago", "1d ago". */
export function formatRelativeElapsed(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
