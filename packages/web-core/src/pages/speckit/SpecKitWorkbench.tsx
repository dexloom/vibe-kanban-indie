import { useCallback, useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { CircleNotchIcon } from '@phosphor-icons/react';
import type {
  SpecKitArtifacts,
  SpecKitFeatureStatus,
  SpecKitStage,
  SpecKitTasks,
} from 'shared/types';
import { specKitApi, ApiError } from '@/shared/lib/api';
import { STAGES, computeStageState } from './stages';
import { StageRail } from './StageRail';
import { ArtifactStage } from './ArtifactStage';
import { ConstitutionStage } from './ConstitutionStage';
import { TasksStage } from './TasksStage';
import { ImplementStage } from './ImplementStage';

/**
 * SpecKit workbench: a read/edit viewer over the artifacts the pipeline's
 * `/speckit.*` slash commands write into the card's own linked workspace.
 * The card's execution agent is the only driver of stages — this page never
 * starts a run; it renders whatever's on disk and lets the operator jump to
 * the live workspace to drive the next stage.
 */
export function SpecKitWorkbench() {
  const { projectId, featureId } = useParams({ strict: false });
  const issueId = featureId;

  const [feature, setFeature] = useState<SpecKitFeatureStatus | null>(null);
  const [artifacts, setArtifacts] = useState<SpecKitArtifacts | null>(null);
  const [tasks, setTasks] = useState<SpecKitTasks | null>(null);
  const [selected, setSelected] = useState<SpecKitStage>('specify');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = feature?.workspace_id ?? null;
  const liveHref =
    workspaceId && projectId && issueId
      ? `/projects/${projectId}/issues/${issueId}/workspaces/${workspaceId}`
      : null;

  const refreshArtifacts = useCallback(async () => {
    if (!issueId) return;
    try {
      const [a, t] = await Promise.all([
        specKitApi.getArtifacts(issueId),
        specKitApi.getTasks(issueId),
      ]);
      setArtifacts(a);
      setTasks(t);
    } catch (e) {
      console.error('[SpecKitWorkbench] refresh failed', e);
    }
  }, [issueId]);

  const loadFeature = useCallback(async () => {
    if (!issueId) return;
    setLoading(true);
    setError(null);
    try {
      const status = await specKitApi.getFeature(issueId);
      setFeature(status);
      if (status.enabled) {
        await refreshArtifacts();
      }
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Failed to load the SpecKit feature.'
      );
    } finally {
      setLoading(false);
    }
  }, [issueId, refreshArtifacts]);

  useEffect(() => {
    void loadFeature();
  }, [loadFeature]);

  if (!projectId || !issueId) {
    return (
      <div className="p-double text-sm text-error">
        Missing project or feature id in the route.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-half text-low">
        <CircleNotchIcon className="size-icon animate-spin" />
        Loading SpecKit…
      </div>
    );
  }

  if (!feature?.enabled) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-half p-double">
        <h2 className="text-lg font-semibold text-high">SpecKit</h2>
        <p className="text-sm text-low">
          {feature?.note ??
            'This card has no workspace yet — start it from the board (pick the SpecKit pipeline).'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <StageRail
        selected={selected}
        onSelect={setSelected}
        stateFor={(stage) => computeStageState(stage, artifacts, tasks, null)}
      />
      <div className="min-w-0 flex-1">
        {error && (
          <div className="border-b bg-error/10 px-double py-half text-sm text-error">
            {error}
          </div>
        )}
        <StagePanel
          stage={selected}
          issueId={issueId}
          artifacts={artifacts}
          tasks={tasks}
          liveHref={liveHref}
          onRefresh={() => void refreshArtifacts()}
          onTasksChanged={setTasks}
        />
      </div>
    </div>
  );
}

interface StagePanelProps {
  stage: SpecKitStage;
  issueId: string;
  artifacts: SpecKitArtifacts | null;
  tasks: SpecKitTasks | null;
  liveHref: string | null;
  onRefresh: () => void;
  onTasksChanged: (tasks: SpecKitTasks) => void;
}

function StagePanel({
  stage,
  issueId,
  artifacts,
  tasks,
  liveHref,
  onRefresh,
  onTasksChanged,
}: StagePanelProps) {
  const meta = STAGES.find((s) => s.stage === stage)!;

  if (stage === 'constitution') {
    return <ConstitutionStage issueId={issueId} liveHref={liveHref} />;
  }

  if (stage === 'tasks') {
    return (
      <TasksStage
        issueId={issueId}
        tasks={tasks}
        liveHref={liveHref}
        onRefresh={onRefresh}
        onTasksChanged={onTasksChanged}
      />
    );
  }

  if (stage === 'implement') {
    return (
      <ImplementStage tasks={tasks} liveHref={liveHref} onRefresh={onRefresh} />
    );
  }

  // specify / clarify / plan / analyze → artifact view.
  const primary =
    stage === 'specify' || stage === 'clarify'
      ? (artifacts?.spec ?? null)
      : stage === 'plan'
        ? (artifacts?.plan ?? null)
        : null;
  const supporting =
    stage === 'plan' && artifacts
      ? [artifacts.research, artifacts.data_model, ...artifacts.contracts]
      : [];

  return (
    <ArtifactStage
      issueId={issueId}
      meta={meta}
      primary={primary}
      supporting={supporting}
      liveHref={liveHref}
      onRefresh={onRefresh}
    />
  );
}
