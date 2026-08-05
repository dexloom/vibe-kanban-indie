import type { Project } from 'shared/remote-types';

export interface BreadcrumbEntry {
  id: string;
  name: string;
}

/**
 * Walk the parent_id chain for `projectId` and return a root-first list of
 * `{id, name}` entries. Pure: O(depth) over `projects`. Missing ancestors
 * are silently dropped (a stale id in the data should not crash the header).
 */
export function buildProjectBreadcrumb(
  projects: readonly Project[],
  projectId: string
): BreadcrumbEntry[] {
  const byId = new Map<string, Project>();
  for (const project of projects) byId.set(project.id, project);
  const out: BreadcrumbEntry[] = [];
  const seen = new Set<string>();
  let current: Project | undefined = byId.get(projectId);
  while (current) {
    if (seen.has(current.id)) break; // cycle guard
    seen.add(current.id);
    out.push({ id: current.id, name: current.name });
    const parentId = current.parent_id ?? null;
    current = parentId ? byId.get(parentId) : undefined;
  }
  out.reverse();
  return out;
}
