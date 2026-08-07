import { describe, expect, it } from 'vitest';
import type { Project } from 'shared/remote-types';
import { sortProjectsByOrder, swapProjectSiblings } from './projectOrder';

function project(overrides: Partial<Project> & { id: string }): Project {
  return {
    id: overrides.id,
    name: overrides.id,
    color: '0 0% 50%',
    sort_order: 0,
    parent_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('swapProjectSiblings', () => {
  it('swaps two siblings and preserves all other projects in their original order', () => {
    const projects: Project[] = [
      project({ id: 'r1', parent_id: null, sort_order: 0 }),
      project({ id: 'a1', parent_id: 'r1', sort_order: 0 }),
      project({ id: 'a2', parent_id: 'r1', sort_order: 1 }),
      project({ id: 'r2', parent_id: null, sort_order: 1 }),
      project({ id: 'b1', parent_id: 'r2', sort_order: 0 }),
      project({ id: 'b2', parent_id: 'r2', sort_order: 1 }),
    ];
    const out = swapProjectSiblings(projects, 'a1', 'a2');
    const ids = out.map((p) => p.id);
    expect(ids).toEqual(['r1', 'a2', 'a1', 'r2', 'b1', 'b2']);
  });

  it('rejects a swap across different parents and returns a copy unchanged', () => {
    const projects: Project[] = [
      project({ id: 'a1', parent_id: 'p1' }),
      project({ id: 'b1', parent_id: 'p2' }),
    ];
    const out = swapProjectSiblings(projects, 'a1', 'b1');
    expect(out).toEqual(projects);
    expect(out).not.toBe(projects);
  });

  it('returns a copy unchanged when ids are missing', () => {
    const projects: Project[] = [project({ id: 'a1' })];
    const out = swapProjectSiblings(projects, 'a1', 'missing');
    expect(out).toEqual(projects);
  });
});

describe('sortProjectsByOrder (ADR-013 sibling primary key)', () => {
  it('groups by parent_id first (roots first, then child sub-buckets)', () => {
    const projects: Project[] = [
      project({ id: 'child', parent_id: 'root' }),
      project({ id: 'root', parent_id: null }),
    ];
    const out = sortProjectsByOrder(projects);
    expect(out.map((p) => p.id)).toEqual(['root', 'child']);
  });
});
