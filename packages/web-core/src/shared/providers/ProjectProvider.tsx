import { useCallback, useMemo, type ReactNode } from 'react';
import { useContext } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import { createHmrContext } from '@/shared/lib/hmrContext';
import type {
  InsertResult,
  MutationResult,
  SyncError,
} from '@/shared/lib/electric/types';
import {
  PROJECTS_SHAPE,
  PROJECT_MUTATION,
  type Project,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from 'shared/remote-types';

/**
 * ProjectProvider — flat projects layer (ADR-018). ADR-019 dropped the
 * tenant-less users list (the User entity has been excised). Consumers read:
 *   - `useProjectsContext()` for the project list + lookup + mutations,
 *   - `useProjects()` for the raw shape (no context needed).
 *
 * NOTE: there is also a per-project `ProjectProvider` at
 * `shared/providers/remote/ProjectProvider.tsx` that exposes issues,
 * statuses, tags, etc. for one project id. The two are independent — this
 * one provides the project LIST; the other provides ONE project's data.
 */
export interface ProjectsContextValue {
  // Data
  projects: Project[];

  // Loading/error state
  isLoading: boolean;
  error: SyncError | null;
  retry: () => void;

  // Project mutations
  insertProject: (data: CreateProjectRequest) => InsertResult<Project>;
  updateProject: (
    id: string,
    changes: Partial<UpdateProjectRequest>
  ) => MutationResult;
  removeProject: (id: string) => MutationResult;

  // Lookup helpers
  getProject: (projectId: string) => Project | undefined;

  // Computed aggregations (O(1) lookup)
  projectsById: Map<string, Project>;
}

const ProjectsContext = createHmrContext<ProjectsContextValue | null>(
  'ProjectsContext',
  null
);

interface ProjectProviderProps {
  children: ReactNode;
}

export function ProjectProvider({ children }: ProjectProviderProps) {
  // Shape subscription — projects are tenant-less now (ADR-018).
  const projectsResult = useShape(
    PROJECTS_SHAPE,
    {},
    {
      mutation: PROJECT_MUTATION,
    }
  );

  const isLoading = projectsResult.isLoading;
  const error = projectsResult.error ?? null;

  const retry = useCallback(() => {
    projectsResult.retry();
  }, [projectsResult]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projectsResult.data) {
      map.set(project.id, project);
    }
    return map;
  }, [projectsResult.data]);

  const getProject = useCallback(
    (projectId: string) => projectsById.get(projectId),
    [projectsById]
  );

  const value = useMemo<ProjectsContextValue>(
    () => ({
      // Data
      projects: projectsResult.data,

      // Loading/error
      isLoading,
      error,
      retry,

      // Project mutations
      insertProject: projectsResult.insert,
      updateProject: projectsResult.update,
      removeProject: projectsResult.remove,

      // Lookup helpers
      getProject,

      // Computed aggregations
      projectsById,
    }),
    [projectsResult, isLoading, error, retry, getProject, projectsById]
  );

  return (
    <ProjectsContext.Provider value={value}>
      {children}
    </ProjectsContext.Provider>
  );
}

/**
 * `useProjectsContext` — read the flat projects layer. Throws if used
 * outside `ProjectProvider`.
 *
 * Named `useProjectsContext` (not `useProjectContext`) so it does not
 * collide with the per-project hook in `shared/hooks/useProjectContext.ts`.
 */
export function useProjectsContext(): ProjectsContextValue {
  const context = useContext(ProjectsContext);
  if (!context) {
    throw new Error('useProjectsContext must be used within a ProjectProvider');
  }
  return context;
}
