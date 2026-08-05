import type { Project } from 'shared/remote-types';

export function compareProjectsByOrder(a: Project, b: Project): number {
  // Sibling-first: same parent_id group orders against itself; cross-parent
  // comparisons are intentionally NOT ordered relative to each other here
  // because the sidebar tree groups them into nested sections. Within a
  // group, `sort_order` wins, then created_at, then id (existing tiebreak).
  const aParent = a.parent_id ?? null;
  const bParent = b.parent_id ?? null;
  if (aParent !== bParent) {
    if (aParent === null) return -1;
    if (bParent === null) return 1;
    return aParent.localeCompare(bParent);
  }

  const bySortOrder = a.sort_order - b.sort_order;
  if (bySortOrder !== 0) {
    return bySortOrder;
  }

  const byCreatedAt =
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }

  return a.id.localeCompare(b.id);
}

export function sortProjectsByOrder<T extends Project>(
  projects: readonly T[]
): T[] {
  return [...projects].sort(compareProjectsByOrder);
}

export function getFirstProjectByOrder<T extends Project>(
  projects: readonly T[]
): T | null {
  if (projects.length === 0) {
    return null;
  }

  return sortProjectsByOrder(projects)[0];
}

/**
 * Pure helper used by the project-reorder DnD path. Given the full project
 * list and two ids `a` / `b`, swap them ONLY when they share the same
 * `parent_id` (siblings). Returns a new array with relative order of every
 * other project preserved.
 */
export function swapProjectSiblings<T extends Project>(
  projects: readonly T[],
  aId: string,
  bId: string
): T[] {
  if (aId === bId) return [...projects];
  const ia = projects.findIndex((project) => project.id === aId);
  const ib = projects.findIndex((project) => project.id === bId);
  if (ia === -1 || ib === -1) return [...projects];
  const a = projects[ia]!;
  const b = projects[ib]!;
  const aParent = a.parent_id ?? null;
  const bParent = b.parent_id ?? null;
  if (aParent !== bParent) return [...projects];
  const out = projects.slice();
  out[ia] = b;
  out[ib] = a;
  return out;
}
