import { PROJECTS_SHAPE, type Project } from 'shared/remote-types';
import { createShapeCollection } from '@/shared/lib/electric/collections';
import { getFirstProjectByOrder } from '@/shared/lib/projectOrder';
import type { AppDestination } from '@/shared/lib/routes/appNavigation';

const FIRST_PROJECT_LOOKUP_TIMEOUT_MS = 3000;

/**
 * Get the global project list directly from the local PROJECTS_SHAPE
 * (ADR-018 — tenant-less, no org fetch).
 */
async function getAllProjects(): Promise<Project[] | null> {
  const collection = createShapeCollection(PROJECTS_SHAPE, {});

  const getCollectionProjects = () =>
    collection.toArray as unknown as Project[];

  if (collection.isReady()) {
    return getCollectionProjects();
  }

  return new Promise<Project[] | null>((resolve) => {
    let settled = false;
    let timeoutId: number | undefined;
    let subscription: { unsubscribe: () => void } | undefined;

    const settle = (projects: Project[] | null) => {
      if (settled) return;
      settled = true;

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (subscription) {
        subscription.unsubscribe();
        subscription = undefined;
      }

      resolve(projects);
    };

    const tryResolve = () => {
      if (!collection.isReady()) {
        return;
      }

      settle(getCollectionProjects());
    };

    subscription = collection.subscribeChanges(tryResolve, {
      includeInitialState: true,
    });

    timeoutId = window.setTimeout(() => {
      settle(null);
    }, FIRST_PROJECT_LOOKUP_TIMEOUT_MS);

    tryResolve();
  });
}

/**
 * ADR-018 — returns the saved project (if it still exists) else the first
 * project by `sort_order`. The org concept is gone, so the
 * `setSelectedOrgId` parameter from the old impl is dropped; only the
 * saved project id is consulted.
 */
export async function getFirstProjectDestination(
  _savedOrgId?: string | null,
  savedProjectId?: string | null
): Promise<AppDestination | null> {
  try {
    const projects = await getAllProjects();

    // If we have a saved project, use it if still valid
    if (savedProjectId && projects) {
      if (projects.some((p) => p.id === savedProjectId)) {
        return { kind: 'project', projectId: savedProjectId };
      }
    }

    // Fall back to first project by sort order
    const firstProject = projects ? getFirstProjectByOrder(projects) : null;
    if (!firstProject) {
      return null;
    }

    return { kind: 'project', projectId: firstProject.id };
  } catch (error) {
    console.error('Failed to resolve first project destination:', error);
    return null;
  }
}
