import { describe, expect, it } from 'vitest';
import type { Workspace } from 'shared/remote-types';
import { selectActiveWorkspace } from './selectActiveWorkspace';

function ws(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    id: overrides.id,
    project_id: 'project-1',
    issue_id: 'issue-1',
    local_workspace_id: overrides.id,
    name: null,
    archived: false,
    files_changed: null,
    lines_added: null,
    lines_removed: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('selectActiveWorkspace', () => {
  it('returns null for an empty list', () => {
    expect(selectActiveWorkspace([])).toBeNull();
  });

  it('picks the newest non-archived workspace by created_at desc', () => {
    const older = ws({ id: 'a', created_at: '2026-01-01T00:00:00Z' });
    const newer = ws({ id: 'b', created_at: '2026-01-02T00:00:00Z' });
    expect(selectActiveWorkspace([older, newer])).toBe(newer);
    expect(selectActiveWorkspace([newer, older])).toBe(newer);
  });

  it('excludes archived workspaces even if newer', () => {
    const active = ws({ id: 'a', created_at: '2026-01-01T00:00:00Z' });
    const archivedNewer = ws({
      id: 'b',
      created_at: '2026-01-02T00:00:00Z',
      archived: true,
    });
    expect(selectActiveWorkspace([active, archivedNewer])).toBe(active);
  });

  it('returns null when every workspace is archived', () => {
    const a = ws({ id: 'a', archived: true });
    const b = ws({ id: 'b', archived: true });
    expect(selectActiveWorkspace([a, b])).toBeNull();
  });

  it('ties on created_at are broken by updated_at desc', () => {
    const staler = ws({
      id: 'a',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const fresher = ws({
      id: 'b',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
    expect(selectActiveWorkspace([staler, fresher])).toBe(fresher);
  });

  it('ties on created_at and updated_at are broken by id', () => {
    const same = '2026-01-01T00:00:00Z';
    const first = ws({ id: 'aaa', created_at: same, updated_at: same });
    const second = ws({ id: 'bbb', created_at: same, updated_at: same });
    // Deterministic regardless of input order.
    expect(selectActiveWorkspace([first, second])).toBe(second);
    expect(selectActiveWorkspace([second, first])).toBe(second);
  });
});
