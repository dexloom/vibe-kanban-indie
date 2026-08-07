import {
  BUCKET_ORDER,
  LEGACY_BUCKET_PERSIST_KEYS,
  type BucketId,
} from '../../lib/buckets';
import {
  makeTasksSectionId,
  makeWorkspacesSectionId,
  type ProjectNode,
  type SidebarTreeNode,
  UNASSIGNED_PROJECT_ID,
} from './types';

/**
 * Read persisted open/closed state for each bucket from the pre-ADR-011
 * per-bucket localStorage keys. Safe to call during render.
 *
 * Collapse-by-default (2026-08-07): the base is all-closed. Only buckets the
 * user EXPLICITLY opened in the old per-bucket localStorage are surfaced —
 * the legacy BUCKET_DEFAULT_OPEN (attention/running/idle open) no longer
 * applies, so first-run users get the new collapsed default.
 */
export function readLegacyBucketOpenState(): Record<BucketId, boolean> {
  const out: Record<BucketId, boolean> = {
    attention: false,
    running: false,
    idle: false,
    archived: false,
  };
  if (typeof window === 'undefined') return out;
  try {
    for (const bucketId of Object.keys(
      LEGACY_BUCKET_PERSIST_KEYS
    ) as BucketId[]) {
      const raw = window.localStorage.getItem(
        `vibe.ui.collapsible.${LEGACY_BUCKET_PERSIST_KEYS[bucketId]}`
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
//
// SINGLE RULE MODEL — every consumer (tree seed, late-arrival restore
// effect) must derive from these helpers; the rule must never be
// re-implemented inline:
//   - `isTasksSectionOpen(stored, projectId)` — the "open only when
//     explicitly persisted `true`" rule (collapse-by-default, owner
//     decision 2026-08-07).
//   - `deriveOpenTasksProjectIds(stored, live)` — persisted-open Set
//     derivation. Retained for callers that want it; NOTE the web-core
//     Tasks loader is no longer gated on this (it loads all live projects
//     so counts render while collapsed — see SidebarProjectTasksRegistry).
//   - `projectIdFromOpenStateKey(key)` — every project-scoped key has the
//     shape `<projectId>:<rest>`; bare ids have no separator.

const SIDEBAR_TREE_OPEN_STATE_KEY = 'vibe.ui.sidebarTree.openState';
const SIDEBAR_TREE_OPEN_STATE_VERSION = 1;

/** Read the persisted open-state blob (or {} on miss / corruption). */
export function readSidebarTreeOpenState(
  liveProjectIds?: ReadonlySet<string>
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
      Object.entries(state).filter(([key]) =>
        liveProjectIds.has(projectIdFromOpenStateKey(key))
      )
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
      JSON.stringify({ v: SIDEBAR_TREE_OPEN_STATE_VERSION, state: map })
    );
  } catch {
    // quota | unavailable — in-memory mirror still authoritative for session
  }
}

/**
 * THE single rule for whether a project's Tasks section is open. Owner
 * decision 2026-08-07: Tasks sections default CLOSED — open ONLY when the
 * user explicitly opened it (persisted `true`). Every consumer (tree seed,
 * late-arrival effect, loader gate) must call this — never re-derive the
 * rule inline. (Previously defaulted open; the collapse-by-default redesign
 * flipped it.)
 */
export function isTasksSectionOpen(
  stored: Readonly<Record<string, boolean>>,
  projectId: string
): boolean {
  return stored[makeTasksSectionId(projectId)] === true;
}

/**
 * Which of the given live projects have their Tasks loaders enabled. Derived
 * from the persisted blob + the live project set — the single derivation of
 * the web-core loader gate. NOTE: post collapse-by-default (2026-08-07) the
 * loader is decoupled from this rule and loads ALL live projects so counts
 * render while collapsed; this helper is retained for back-compat / callers
 * that still want the persisted-open derivation.
 */
export function deriveOpenTasksProjectIds(
  stored: Readonly<Record<string, boolean>>,
  liveProjectIds: Iterable<string>
): Set<string> {
  const out = new Set<string>();
  for (const pid of liveProjectIds) {
    if (isTasksSectionOpen(stored, pid)) out.add(pid);
  }
  return out;
}

/** Extract the projectId a persisted open-state key is scoped to (the text
 * before the first ':' — bucket/status/card/tasks keys are all
 * `<projectId>:<rest>`; a bare project id has no separator). */
export function projectIdFromOpenStateKey(key: string): string {
  const separatorIndex = key.indexOf(':');
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

/**
 * Build the `initialOpenState` map for <Tree>. Per-node resolution:
 *   1. value persisted in the sidebar-tree blob
 *   2. legacy per-bucket value (buckets only, first-run migration)
 *   3. default: CLOSED. Owner decision 2026-08-07 (collapse-by-default
 *      redesign) — projects, Tasks sections, Workspaces sections, buckets,
 *      and statuses all default collapsed; the user's explicit expand/
 *      collapse persists across sessions. (Previously projects, Workspaces
 *      sections, Tasks sections, and attention/running/idle buckets
 *      defaulted OPEN.)
 *
 * Status nodes are INTENTIONALLY NOT seeded: their ids are unknown at mount
 * (tasks load lazily once the Tasks section is opened). With
 * `openByDefault={false}`, un-seeded ids default CLOSED — exactly the desired
 * first-open behavior. Seeding them here would be impossible (ids unknown) and
 * pointless. See ADR-011.
 *
 * As before, only the value at Tree mount is consumed; the prop is ignored
 * post-mount (verified: react-arborist `state/initial.js` seeds once inside
 * `useRef(createStore(...))`).
 */
export function buildSidebarTreeInitialOpenState(
  tree: readonly SidebarTreeNode[]
): Record<string, boolean> {
  const projectNodes = tree.filter(
    (n): n is ProjectNode => n.type === 'project'
  );
  const liveProjectIds = new Set(projectNodes.map((p) => p.id));
  const stored = readSidebarTreeOpenState(liveProjectIds);
  const useLegacy = Object.keys(stored).length === 0;
  const legacy: Partial<Record<BucketId, boolean>> = useLegacy
    ? readLegacyBucketOpenState()
    : {};

  const out: Record<string, boolean> = {};
  for (const project of projectNodes) {
    const projectId = project.id;
    const isUnassigned = projectId === UNASSIGNED_PROJECT_ID;
    out[projectId] = stored[projectId] ?? false;

    const wsId = makeWorkspacesSectionId(projectId);
    out[wsId] = stored[wsId] ?? false;

    for (const bucketId of BUCKET_ORDER) {
      const nodeId = `${projectId}:bucket:${bucketId}`;
      // Legacy first-run migration: a pre-ADR-011 user's per-bucket open
      // state is honored once; thereafter the blob owns the value. New
      // users (no blob, no legacy) default CLOSED.
      out[nodeId] = stored[nodeId] ?? legacy[bucketId] ?? false;
    }

    // Tasks section: real projects only. Default CLOSED via the central
    // rule (owner decision 2026-08-07). Unassigned never has a Tasks
    // section, so do not emit an id for it (keeps the map clean and
    // prevents a phantom persisted key).
    if (!isUnassigned) {
      const tasksId = makeTasksSectionId(projectId);
      out[tasksId] = isTasksSectionOpen(stored, projectId);
    }
  }
  return out;
}

/**
 * Status/card ids persisted OPEN that are present in the current tree and have
 * not been applied yet. Unlike project/section/bucket state (seeded into
 * initialOpenState at mount), status/card nodes load lazily AFTER the Tree
 * consumed its initial map, so their persisted open state must be applied
 * incrementally as data arrives — see SidebarProjectTree restore effect.
 */
export function pendingOpenStatusCardIds(
  stored: Readonly<Record<string, boolean>>,
  applied: ReadonlySet<string>,
  node: (id: string) => { type: string } | null | undefined
): string[] {
  const out: string[] = [];
  for (const [id, open] of Object.entries(stored)) {
    if (open !== true || applied.has(id)) continue;
    const n = node(id);
    if (n && (n.type === 'status' || n.type === 'card')) out.push(id);
  }
  return out;
}

/**
 * Depth-first lookup of a tree node by id in the BUILT tree data. Unlike
 * react-arborist's `TreeApi.get(id)` (which only resolves VISIBLE/flattened
 * nodes), this finds nodes under collapsed ancestors too — required so the
 * replay effect can restore a card whose parent status is still closed at
 * replay time (it opens the card id; the store applies it when the status
 * renders). O(N) per call, N bounded by sidebar tree size (~hundreds).
 */
export function findTreeNodeById(
  nodes: readonly SidebarTreeNode[],
  id: string
): SidebarTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if ('children' in node && node.children && node.children.length > 0) {
      const found = findTreeNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * ADR-015: walk the built tree and return every node id as a Set. Used by
 * the prune effect to drop persisted open-state keys whose FULL node id is
 * no longer present (e.g. a nested-board `<childId>:workspaces` key from
 * before the root-only-Workspaces change). Pair with the existing
 * project-prefix prune for the fast-path deleted-project case.
 */
export function liveTreeNodeIds(
  nodes: readonly SidebarTreeNode[]
): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly SidebarTreeNode[]): void => {
    for (const node of list) {
      out.add(node.id);
      // Some node types (e.g. ADR-016 OrchestratorPromptNode) are leaves
      // that don't carry a `children` field — the `in` check both
      // narrows the type and avoids the runtime TypeError on `.length`.
      if (
        node.type !== 'leaf' &&
        'children' in node &&
        node.children.length > 0
      ) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
