import { describe, expect, it } from 'vitest';
import type { Project } from 'shared/remote-types';
import { buildProjectBreadcrumb } from './buildProjectBreadcrumb';

function project(
  id: string,
  overrides: Partial<Project> = {}
): Pick<Project, 'id' | 'name' | 'parent_id'> {
  return {
    id,
    name: id,
    color: '0 0% 50%',
    sort_order: 0,
    parent_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildProjectBreadcrumb', () => {
  it('returns a single entry for a root project', () => {
    const out = buildProjectBreadcrumb(
      [project('root', { name: 'Root' })],
      'root'
    );
    expect(out).toEqual([{ id: 'root', name: 'Root' }]);
  });

  it('walks the parent chain root → leaf for a nested project', () => {
    const out = buildProjectBreadcrumb(
      [
        project('root', { name: 'ACME' }),
        project('sub', { name: 'SUB', parent_id: 'root' }),
        project('leaf', { name: 'X', parent_id: 'sub' }),
      ],
      'leaf'
    );
    expect(out).toEqual([
      { id: 'root', name: 'ACME' },
      { id: 'sub', name: 'SUB' },
      { id: 'leaf', name: 'X' },
    ]);
  });

  it('stops at the first missing ancestor without throwing', () => {
    const out = buildProjectBreadcrumb(
      [
        project('root', { name: 'ACME' }),
        project('orphan', { name: 'Orphan', parent_id: 'missing' }),
      ],
      'orphan'
    );
    expect(out).toEqual([{ id: 'orphan', name: 'Orphan' }]);
  });
});
