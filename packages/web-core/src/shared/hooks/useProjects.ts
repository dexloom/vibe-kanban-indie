import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import { useAuth } from '@/shared/hooks/auth/useAuth';
import {
  PROJECTS_SHAPE,
  PROJECT_MUTATION,
  type Project,
} from 'shared/remote-types';

/**
 * Tenant-less replacement for `useOrganizationProjects`.
 *
 * ADR-018 — the local-only fork has no org concept, so projects are a
 * single global shape. Subscribes `PROJECTS_SHAPE` with empty params
 * (`createShapeCollection` keys on the table name, so empty params share
 * one cache key across the app).
 */
export function useProjects() {
  const { isSignedIn } = useAuth();

  const { data, isLoading, error, insert, update, remove } = useShape(
    PROJECTS_SHAPE,
    {},
    {
      enabled: isSignedIn,
      mutation: PROJECT_MUTATION,
    }
  );

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of data) {
      map.set(project.id, project);
    }
    return map;
  }, [data]);

  return {
    data,
    isLoading,
    isError: !!error,
    error,
    insert,
    update,
    remove,
    projectsById,
  };
}
