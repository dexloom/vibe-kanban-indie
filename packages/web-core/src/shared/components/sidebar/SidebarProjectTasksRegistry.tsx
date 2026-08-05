import { useCallback, useEffect, useState } from 'react';
import { useProjectTasks } from '@/shared/hooks/useProjectTasks';
import type { ProjectTasksData } from '@vibe/ui/components/outliner/types';

interface SidebarProjectTasksRegistryProps {
  projectIds: readonly string[];
  openTasksProjectIds: ReadonlySet<string>;
  onTasksByProject: (map: ReadonlyMap<string, ProjectTasksData>) => void;
  onLoadingTasksProjectIds: (set: ReadonlySet<string>) => void;
}

/** Rules-of-hooks-safe registry for lazily enabled per-project task loaders. */
export function SidebarProjectTasksRegistry({
  projectIds,
  openTasksProjectIds,
  onTasksByProject,
  onLoadingTasksProjectIds,
}: SidebarProjectTasksRegistryProps) {
  const [dataMap, setDataMap] = useState<Map<string, ProjectTasksData>>(
    () => new Map()
  );
  const [loadingSet, setLoadingSet] = useState<Set<string>>(() => new Set());

  const reportData = useCallback((id: string, data: ProjectTasksData) => {
    setDataMap((previous) => {
      const next = new Map(previous);
      next.set(id, data);
      return next;
    });
  }, []);

  const reportLoading = useCallback((id: string, isLoading: boolean) => {
    setLoadingSet((previous) => {
      const hasProject = previous.has(id);
      if (isLoading === hasProject) return previous;

      const next = new Set(previous);
      if (isLoading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Drop entries for projects that no longer exist (deleted/removed) so the
  // registry doesn't leak stale data across a long-lived session.
  useEffect(() => {
    const live = new Set(projectIds);
    setDataMap((previous) => {
      const next = new Map(previous);
      let changed = false;
      for (const id of next.keys()) {
        if (!live.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setLoadingSet((previous) => {
      const next = new Set(previous);
      let changed = false;
      for (const id of previous) {
        if (!live.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [projectIds]);

  useEffect(() => {
    onTasksByProject(dataMap);
  }, [dataMap, onTasksByProject]);

  useEffect(() => {
    onLoadingTasksProjectIds(loadingSet);
  }, [loadingSet, onLoadingTasksProjectIds]);

  return (
    <>
      {projectIds.map((projectId) => (
        <ProjectTasksLoader
          key={projectId}
          projectId={projectId}
          enabled={openTasksProjectIds.has(projectId)}
          onData={reportData}
          onLoading={reportLoading}
        />
      ))}
    </>
  );
}

interface ProjectTasksLoaderProps {
  projectId: string;
  enabled: boolean;
  onData: (id: string, data: ProjectTasksData) => void;
  onLoading: (id: string, isLoading: boolean) => void;
}

function ProjectTasksLoader({
  projectId,
  enabled,
  onData,
  onLoading,
}: ProjectTasksLoaderProps) {
  const { statuses, issues, isLoading } = useProjectTasks(projectId, enabled);

  useEffect(() => {
    if (enabled) onData(projectId, { statuses, issues });
  }, [enabled, projectId, statuses, issues, onData]);

  useEffect(() => {
    onLoading(projectId, isLoading);
  }, [projectId, isLoading, onLoading]);

  return null;
}
