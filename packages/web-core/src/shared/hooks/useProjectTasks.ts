import { useMemo } from 'react';
import { useShape } from '@/shared/integrations/electric/hooks';
import {
  PROJECT_ISSUES_SHAPE,
  PROJECT_PROJECT_STATUSES_SHAPE,
} from 'shared/remote-types';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';

export interface ProjectTasksResult extends ProjectTasksData {
  isLoading: boolean;
}

/** Subscribe lazily to one project's statuses and issues. */
export function useProjectTasks(
  projectId: string,
  enabled: boolean
): ProjectTasksResult {
  const params = useMemo(() => ({ project_id: projectId }), [projectId]);
  const statuses = useShape(PROJECT_PROJECT_STATUSES_SHAPE, params, {
    enabled,
  });
  const issues = useShape(PROJECT_ISSUES_SHAPE, params, { enabled });

  return {
    statuses: statuses.data,
    issues: issues.data,
    isLoading: enabled && (statuses.isLoading || issues.isLoading),
  };
}
