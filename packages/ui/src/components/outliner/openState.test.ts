import { beforeEach, describe, expect, it } from 'vitest';
import { UNASSIGNED_PROJECT_ID, type SidebarTreeNode } from './types';
import {
  buildSidebarTreeInitialOpenState,
  deriveOpenTasksProjectIds,
  isTasksSectionOpen,
  projectIdFromOpenStateKey,
  readSidebarTreeOpenState,
  writeSidebarTreeOpenState,
} from './openState';

class MemoryStorage {
  private store = new Map<string, string>();
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const installLocalStorage = (): void => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: new MemoryStorage(),
  });
};

const SIDEBAR_BLOB_KEY = 'vibe.ui.sidebarTree.openState';

const projectNode = (id: string): SidebarTreeNode => ({
  id,
  type: 'project',
  name: id,
  color: '0 0% 50%',
  parentId: null,
  sortOrder: 0,
  children: [],
});

beforeEach(() => {
  installLocalStorage();
});

describe('isTasksSectionOpen', () => {
  it('defaults a real project to CLOSED when no entry is persisted (collapse-by-default 2026-08-07)', () => {
    expect(isTasksSectionOpen({}, 'p1')).toBe(false);
  });

  it('returns false when the entry is explicitly persisted false', () => {
    expect(isTasksSectionOpen({ 'p1:tasks': false }, 'p1')).toBe(false);
  });

  it('returns true when the entry is explicitly persisted true', () => {
    expect(isTasksSectionOpen({ 'p1:tasks': true }, 'p1')).toBe(true);
  });

  it('ignores entries for other projects (defaults CLOSED)', () => {
    expect(isTasksSectionOpen({ 'p2:tasks': false }, 'p1')).toBe(false);
  });
});

describe('deriveOpenTasksProjectIds', () => {
  it('returns NO projects when nothing is persisted (collapse-by-default)', () => {
    expect(deriveOpenTasksProjectIds({}, ['p1', 'p2'])).toEqual(new Set());
  });

  it('includes ONLY a project with an explicit true entry', () => {
    expect(
      deriveOpenTasksProjectIds({ 'p1:tasks': true }, ['p1', 'p2'])
    ).toEqual(new Set(['p1']));
  });

  it('excludes a project with an explicit false entry (and all default-closed ones)', () => {
    expect(
      deriveOpenTasksProjectIds({ 'p2:tasks': false }, ['p1', 'p2'])
    ).toEqual(new Set());
  });

  it('only considers given live ids — ignores a persisted-open id not in the live set', () => {
    expect(deriveOpenTasksProjectIds({ 'gone:tasks': true }, ['p1'])).toEqual(
      new Set()
    );
  });

  it('returns an empty set when no live ids are provided', () => {
    expect(deriveOpenTasksProjectIds({ 'p1:tasks': true }, [])).toEqual(
      new Set()
    );
  });
});

describe('projectIdFromOpenStateKey', () => {
  it('returns the text before the first colon for a bucket key', () => {
    expect(projectIdFromOpenStateKey('p1:bucket:idle')).toBe('p1');
  });

  it('returns the text before the first colon for a status key', () => {
    expect(projectIdFromOpenStateKey('p1:status:s1')).toBe('p1');
  });

  it('returns the bare id when the key has no separator', () => {
    expect(projectIdFromOpenStateKey('p1')).toBe('p1');
  });

  it('returns the unassigned pseudo-project id for unassigned-scoped keys', () => {
    expect(
      projectIdFromOpenStateKey(`${UNASSIGNED_PROJECT_ID}:bucket:idle`)
    ).toBe(UNASSIGNED_PROJECT_ID);
  });
});

describe('readSidebarTreeOpenState GC filter (regression)', () => {
  it('drops persisted keys whose project is not in the live set', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({
        v: 1,
        state: {
          p1: true,
          'p1:tasks': true,
          'p1:bucket:idle': true,
          'p2:tasks': true,
          'p2:status:s1': true,
        },
      })
    );
    const live = new Set(['p1']);
    expect(readSidebarTreeOpenState(live)).toEqual({
      p1: true,
      'p1:tasks': true,
      'p1:bucket:idle': true,
    });
  });

  it('keeps bare-id entries for projects that ARE in the live set', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({ v: 1, state: { p1: true, p2: true } })
    );
    expect(readSidebarTreeOpenState(new Set(['p1', 'p2']))).toEqual({
      p1: true,
      p2: true,
    });
  });
});

// Regression: buildSidebarTreeInitialOpenState still honors the rule via
// isTasksSectionOpen. Collapse-by-default (2026-08-07): Tasks sections and
// every other level seed CLOSED absent persisted state.
describe('buildSidebarTreeInitialOpenState (collapse-by-default)', () => {
  it('seeds a real project Tasks section CLOSED when nothing is persisted', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    expect(buildSidebarTreeInitialOpenState(tree)['p1:tasks']).toBe(false);
  });

  it('seeds a real project Tasks section CLOSED when explicitly persisted false', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({ v: 1, state: { 'p1:tasks': false } })
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    expect(buildSidebarTreeInitialOpenState(tree)['p1:tasks']).toBe(false);
  });

  it('seeds a real project Tasks section OPEN when explicitly persisted true', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({ v: 1, state: { 'p1:tasks': true } })
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    expect(buildSidebarTreeInitialOpenState(tree)['p1:tasks']).toBe(true);
  });

  it('seeds the project row, Workspaces section, and buckets CLOSED by default', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const state = buildSidebarTreeInitialOpenState(tree);
    expect(state['p1']).toBe(false);
    expect(state['p1:workspaces']).toBe(false);
    expect(state['p1:bucket:attention']).toBe(false);
    expect(state['p1:bucket:running']).toBe(false);
    expect(state['p1:bucket:idle']).toBe(false);
    expect(state['p1:bucket:archived']).toBe(false);
  });

  it('honors persisted-OPEN values for project, workspaces section, and buckets', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({
        v: 1,
        state: {
          p1: true,
          'p1:workspaces': true,
          'p1:bucket:attention': true,
        },
      })
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const state = buildSidebarTreeInitialOpenState(tree);
    expect(state['p1']).toBe(true);
    expect(state['p1:workspaces']).toBe(true);
    expect(state['p1:bucket:attention']).toBe(true);
    // Unpersisted buckets still default CLOSED.
    expect(state['p1:bucket:idle']).toBe(false);
  });
});

// Regression: the gate derivation used by web-core must match the same rule
// the tree seed uses, so a Tasks section left open survives a reload.
describe('deriveOpenTasksProjectIds integration with persisted blob', () => {
  it('matches readSidebarTreeOpenState output for a live project set', () => {
    writeSidebarTreeOpenState({
      p1: true,
      'p1:workspaces': true,
      'p1:tasks': true,
      'p1:bucket:idle': true,
      'p2:tasks': false,
    });
    const live = new Set(['p1', 'p2']);
    const stored = readSidebarTreeOpenState(live);
    expect(deriveOpenTasksProjectIds(stored, live)).toEqual(new Set(['p1']));
  });
});

// ADR-015: stale-key GC. Nested boards no longer render a Workspaces
// section (only roots do). The prune effect must drop persisted keys
// whose FULL node id is no longer in the live tree — not just keys whose
// project prefix is missing — so `<childId>:workspaces` and
// `<childId>:bucket:*` keys don't accumulate forever.
describe('liveTreeNodeIds (ADR-015 stale-key GC)', () => {
  it('returns a Set of every node id reachable in the built tree', async () => {
    const { liveTreeNodeIds } = await import('./openState');
    const tree: readonly SidebarTreeNode[] = [
      {
        id: 'p1',
        type: 'project',
        name: 'p1',
        color: '0 0% 50%',
        parentId: null,
        sortOrder: 0,
        children: [
          {
            id: 'p1:tasks',
            type: 'section',
            kind: 'tasks',
            projectId: 'p1',
            label: 'Tasks',
            openTaskCount: 0,
            children: [],
          },
          {
            id: 'p1:workspaces',
            type: 'section',
            kind: 'workspaces',
            projectId: 'p1',
            label: 'Workspaces',
            children: [
              {
                id: 'p1:bucket:idle',
                type: 'bucket',
                bucketId: 'idle',
                name: 'Idle',
                children: [],
              },
            ],
          },
          {
            id: 'p2',
            type: 'project',
            name: 'p2',
            color: '0 0% 50%',
            parentId: 'p1',
            sortOrder: 0,
            children: [
              {
                id: 'p2:tasks',
                type: 'section',
                kind: 'tasks',
                projectId: 'p2',
                label: 'Tasks',
                openTaskCount: 0,
                children: [],
              },
            ],
          },
        ],
      },
    ];
    const ids = liveTreeNodeIds(tree);
    expect(ids).toEqual(
      new Set([
        'p1',
        'p1:tasks',
        'p1:workspaces',
        'p1:bucket:idle',
        'p2',
        'p2:tasks',
      ])
    );
  });
});
