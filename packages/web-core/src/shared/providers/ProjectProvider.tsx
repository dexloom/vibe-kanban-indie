import { useCallback, useMemo, type ReactNode } from 'react';
import { useContext } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import { useUsers } from '@/shared/hooks/useUsers';
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
import type { UserWithProfile } from 'shared/types';

/**
 * ProjectProvider — flat projects layer (ADR-018).
 *
 * Replaces the deleted `OrgProvider` with the same context shape minus the
 * org concept. Subscribes `PROJECTS_SHAPE` (tenant-less, empty params) and
 * pulls users from `useUsers` (`/v1/users`). Consumers read either:
 *   - `useProjectsContext()` for the project list + lookup + mutations,
 *   - `useUsers()` for the user roster,
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
  users: UserWithProfile[];

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
  usersById: Map<string, UserWithProfile>;
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

  // Users — tenant-less endpoint `/v1/users`.
  const usersQuery = useUsers();

  const isLoading = projectsResult.isLoading || usersQuery.isLoading;
  const error = projectsResult.error ?? null;

  const retry = useCallback(() => {
    projectsResult.retry();
    void usersQuery.refetch();
  }, [projectsResult, usersQuery]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projectsResult.data) {
      map.set(project.id, project);
    }
    return map;
  }, [projectsResult.data]);

  const usersById = useMemo(() => {
    const map = new Map<string, UserWithProfile>();
    for (const user of usersQuery.data ?? []) {
      map.set(user.user_id, user);
    }
    return map;
  }, [usersQuery.data]);

  const getProject = useCallback(
    (projectId: string) => projectsById.get(projectId),
    [projectsById]
  );

  const value = useMemo<ProjectsContextValue>(
    () => ({
      // Data
      projects: projectsResult.data,
      users: usersQuery.data ?? [],

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
      usersById,
    }),
    [
      projectsResult,
      usersQuery.data,
      isLoading,
      error,
      retry,
      getProject,
      projectsById,
      usersById,
    ]
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
