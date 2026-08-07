import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_ORDER, LEGACY_BUCKET_PERSIST_KEYS } from '../../lib/buckets';
import { UNASSIGNED_PROJECT_ID, type SidebarTreeNode } from './types';
import {
  buildSidebarTreeInitialOpenState,
  findTreeNodeById,
  pendingOpenStatusCardIds,
} from './openState';

// vitest's default jsdom environment ships `localStorage` as an empty stub
// object (no Storage methods). Polyfill with an in-memory map so the
// persistence code under test can read/write freely.
class MemoryStorage {
  private store = new Map<string, string>();
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
  removeItem(key: string): void {
    this.store.delete(key);
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

const projectNode = (id: string): SidebarTreeNode => ({
  id,
  type: 'project',
  name: id,
  color: '0 0% 50%',
  parentId: null,
  sortOrder: 0,
  children: [],
});

const SIDEBAR_BLOB_KEY = 'vibe.ui.sidebarTree.openState';

afterEach(() => {
  installLocalStorage();
});

beforeEach(() => {
  installLocalStorage();
});

describe('buildSidebarTreeInitialOpenState', () => {
  it('defaults the Tasks section to CLOSED for a real project (collapse-by-default)', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1:tasks']).toBe(false);
  });

  it('does not seed any status node ids', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    const statusKeys = Object.keys(out).filter((k) => /^p1:status:/.test(k));
    expect(statusKeys).toEqual([]);
  });

  it('defaults ALL buckets CLOSED (collapse-by-default)', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    for (const bucketId of BUCKET_ORDER) {
      expect(out[`p1:bucket:${bucketId}`]).toBe(false);
    }
  });

  it('defaults the project row and Workspaces section CLOSED', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1']).toBe(false);
    expect(out['p1:workspaces']).toBe(false);
  });

  it('lets a persisted Tasks-section value override the default', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({ v: 1, state: { 'p1:tasks': false } })
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1:tasks']).toBe(false);
  });

  it('honors a persisted-OPEN Tasks-section value', () => {
    window.localStorage.setItem(
      SIDEBAR_BLOB_KEY,
      JSON.stringify({ v: 1, state: { 'p1:tasks': true } })
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1:tasks']).toBe(true);
  });

  it('does not emit a tasks id for the Unassigned pseudo-project', () => {
    const tree: readonly SidebarTreeNode[] = [
      projectNode('p1'),
      projectNode(UNASSIGNED_PROJECT_ID),
    ];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out[`${UNASSIGNED_PROJECT_ID}:tasks`]).toBeUndefined();
    expect(
      Object.keys(out).some((k) => k.startsWith(`${UNASSIGNED_PROJECT_ID}:`))
    ).toBe(true);
    expect(
      Object.keys(out).some((k) => k === `${UNASSIGNED_PROJECT_ID}:tasks`)
    ).toBe(false);
  });

  it('migrates legacy per-bucket values when the blob is empty (collapse-by-default base)', () => {
    // Only EXPLICITLY-set legacy values surface; absent legacy keys default
    // CLOSED (the new collapse-by-default base, not the old BUCKET_DEFAULT_OPEN).
    window.localStorage.setItem(
      `vibe.ui.collapsible.${LEGACY_BUCKET_PERSIST_KEYS.attention}`,
      'false'
    );
    window.localStorage.setItem(
      `vibe.ui.collapsible.${LEGACY_BUCKET_PERSIST_KEYS.running}`,
      'true'
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1:bucket:attention']).toBe(false); // explicit legacy false
    expect(out['p1:bucket:running']).toBe(true); // explicit legacy true
    expect(out['p1:bucket:idle']).toBe(false); // no legacy → closed
    expect(out['p1:bucket:archived']).toBe(false); // no legacy → closed
  });
});

describe('pendingOpenStatusCardIds', () => {
  const node = (id: string): { type: string } | null => {
    if (id === 'p1:status:s1') return { type: 'status' };
    if (id === 'p1:card:c1') return { type: 'card' };
    if (id === 'p1') return { type: 'project' };
    if (id === 'p1:tasks') return { type: 'section' };
    return null;
  };

  it('returns stored-open status/card ids that are present and unapplied', () => {
    const stored = {
      p1: true,
      'p1:tasks': true,
      'p1:status:s1': true,
      'p1:card:c1': true,
    };
    expect(pendingOpenStatusCardIds(stored, new Set(), node).sort()).toEqual([
      'p1:card:c1',
      'p1:status:s1',
    ]);
  });

  it('skips closed, non-status/card, absent, and already-applied ids', () => {
    const stored = {
      'p1:status:s1': false,
      'p1:card:c1': true,
      p1: true,
      'p1:tasks': true,
      'p1:status:ghost': true,
    };
    expect(
      pendingOpenStatusCardIds(stored, new Set(['p1:card:c1']), node)
    ).toEqual([]);
  });
});

describe('findTreeNodeById', () => {
  const tree: SidebarTreeNode[] = [
    {
      id: 'p1',
      type: 'project',
      parentId: null,
      name: 'P1',
      color: '0 0% 50%',
      sortOrder: 0,
      children: [
        {
          id: 'p1:tasks',
          type: 'section',
          kind: 'tasks',
          projectId: 'p1',
          label: 'Tasks',
          openTaskCount: 0,
          children: [
            {
              id: 'p1:status:s1',
              type: 'status',
              projectId: 'p1',
              statusId: 's1',
              name: 'Todo',
              color: '0 0% 50%',
              children: [
                {
                  id: 'p1:card:c1',
                  type: 'card',
                  issue: {
                    id: 'c1',
                    title: 'Fix',
                    priority: null,
                    statusId: 's1',
                    projectId: 'p1',
                    parentIssueId: null,
                  },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  it('finds a deeply nested card under collapsed ancestors', () => {
    expect(findTreeNodeById(tree, 'p1:card:c1')?.type).toBe('card');
  });

  it('returns null for an unknown id', () => {
    expect(findTreeNodeById(tree, 'p9:status:ghost')).toBeNull();
  });
});
