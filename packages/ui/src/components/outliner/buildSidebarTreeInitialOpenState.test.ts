import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUCKET_ORDER,
  LEGACY_BUCKET_PERSIST_KEYS,
  UNASSIGNED_PROJECT_ID,
  buildSidebarTreeInitialOpenState,
  readOpenTasksProjectIds,
  writeSidebarTreeOpenState,
  type SidebarTreeNode,
} from './types';

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
  it('defaults the Tasks section to CLOSED for a real project', () => {
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

  it('preserves bucket defaults from BUCKET_DEFAULT_OPEN', () => {
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    for (const bucketId of BUCKET_ORDER) {
      const expected = bucketId === 'archived' ? false : true;
      expect(out[`p1:bucket:${bucketId}`]).toBe(expected);
    }
  });

  it('lets a persisted Tasks-section value override the default', () => {
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

  it('migrates legacy per-bucket values when the blob is empty', () => {
    window.localStorage.setItem(
      `vibe.ui.collapsible.${LEGACY_BUCKET_PERSIST_KEYS.attention}`,
      'false'
    );
    const tree: readonly SidebarTreeNode[] = [projectNode('p1')];
    const out = buildSidebarTreeInitialOpenState(tree);
    expect(out['p1:bucket:attention']).toBe(false);
    expect(out['p1:bucket:running']).toBe(true);
    expect(out['p1:bucket:idle']).toBe(true);
    expect(out['p1:bucket:archived']).toBe(false);
  });

  it('readOpenTasksProjectIds returns projects whose Tasks section is open', () => {
    writeSidebarTreeOpenState({
      'p1': true,
      'p1:workspaces': true,
      'p1:tasks': true,
      'p1:bucket:idle': true,
      'p2:tasks': false,
      'p2:workspaces': false,
    });
    expect(readOpenTasksProjectIds()).toEqual(['p1']);
  });

  it('readOpenTasksProjectIds respects an explicit map without localStorage', () => {
    expect(
      readOpenTasksProjectIds({ 'p1:tasks': true, 'p2:tasks': false })
    ).toEqual(['p1']);
    expect(readOpenTasksProjectIds({})).toEqual([]);
  });
});
