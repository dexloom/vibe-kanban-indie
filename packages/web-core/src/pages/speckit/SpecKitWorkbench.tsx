import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { CircleNotchIcon } from '@phosphor-icons/react';
import {
  ExecutionProcessStatus,
  type SpecKitArtifacts,
  type SpecKitFeatureStatus,
  type SpecKitStage,
  type SpecKitTasks,
} from 'shared/types';
import { specKitApi, executionProcessesApi, ApiError } from '@/shared/lib/api';
import { STAGES, computeStageState } from './stages';
import { StageRail } from './StageRail';
import { ArtifactStage } from './ArtifactStage';
import { ConstitutionStage } from './ConstitutionStage';
import { TasksStage } from './TasksStage';
import { ImplementStage } from './ImplementStage';
import { SpecKitSetup } from './SpecKitSetup';

interface ActiveRun {
  stage: SpecKitStage;
  executionProcessId: string;
}

export function SpecKitWorkbench() {
  const { projectId, featureId } = useParams({ strict: false });
  const issueId = featureId;

  const [feature, setFeature] = useState<SpecKitFeatureStatus | null>(null);
  const [artifacts, setArtifacts] = useState<SpecKitArtifacts | null>(null);
  const [tasks, setTasks] = useState<SpecKitTasks | null>(null);
  const [selected, setSelected] = useState<SpecKitStage>('specify');
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

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

  // Stop polling on unmount.
  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleRun = useCallback(
    async (stage: SpecKitStage, input: string | null) => {
      if (!issueId) return;
      setError(null);
      try {
        const res = await specKitApi.runStage(issueId, {
          stage,
          input: input ?? undefined,
        });
        setActiveRun({ stage, executionProcessId: res.execution_process_id });
        stopPolling();
        // Poll the run + refresh artifacts while it executes.
        pollRef.current = window.setInterval(() => {
          void (async () => {
            await refreshArtifacts();
            try {
              const detail = await executionProcessesApi.getDetails(
                res.execution_process_id
              );
              if (detail.status !== ExecutionProcessStatus.running) {
                stopPolling();
                setActiveRun(null);
                await refreshArtifacts();
              }
            } catch {
              // Keep polling; transient errors shouldn't kill the loop.
            }
          })();
        }, 4000);
      } catch (e) {
        setError(
          e instanceof ApiError ? e.message : 'Failed to start the run.'
        );
      }
    },
    [issueId, refreshArtifacts, stopPolling]
  );

  const runningStage = activeRun?.stage ?? null;

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
      <SpecKitSetup
        projectId={projectId}
        issueId={issueId}
        onCreated={() => {
          setSelected('specify');
          void loadFeature();
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <StageRail
        selected={selected}
        onSelect={setSelected}
        stateFor={(stage) =>
          computeStageState(stage, artifacts, tasks, runningStage)
        }
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
          runningStage={runningStage}
          liveHref={liveHref}
          onRun={(s, i) => void handleRun(s, i)}
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
  runningStage: SpecKitStage | null;
  liveHref: string | null;
  onRun: (stage: SpecKitStage, input: string | null) => void;
  onRefresh: () => void;
  onTasksChanged: (tasks: SpecKitTasks) => void;
}

function StagePanel({
  stage,
  issueId,
  artifacts,
  tasks,
  runningStage,
  liveHref,
  onRun,
  onRefresh,
  onTasksChanged,
}: StagePanelProps) {
  const meta = STAGES.find((s) => s.stage === stage)!;
  const running = runningStage === stage;

  if (stage === 'constitution') {
    return (
      <ConstitutionStage
        issueId={issueId}
        running={running}
        liveHref={liveHref}
        onRun={onRun}
      />
    );
  }

  if (stage === 'tasks') {
    return (
      <TasksStage
        issueId={issueId}
        tasks={tasks}
        running={running}
        liveHref={liveHref}
        onRun={onRun}
        onRefresh={onRefresh}
        onTasksChanged={onTasksChanged}
      />
    );
  }

  if (stage === 'implement') {
    return (
      <ImplementStage
        tasks={tasks}
        running={running}
        liveHref={liveHref}
        onRun={onRun}
        onRefresh={onRefresh}
      />
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
      running={running}
      liveHref={liveHref}
      onRun={onRun}
      onRefresh={onRefresh}
    />
  );
}
