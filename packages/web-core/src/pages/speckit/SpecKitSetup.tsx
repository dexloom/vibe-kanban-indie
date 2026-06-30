import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleNotchIcon, RocketLaunchIcon } from '@phosphor-icons/react';
import {
  BaseCodingAgent,
  type Repo,
  type WorkspaceRepoInput,
} from 'shared/types';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { getProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import { repoApi, specKitApi, ApiError } from '@/shared/lib/api';

interface SpecKitSetupProps {
  projectId: string;
  issueId: string;
  onCreated: (workspaceId: string) => void;
}

interface CandidateRepo {
  repoId: string;
  name: string;
  targetBranch: string;
}

function prettyExecutor(executor: BaseCodingAgent): string {
  return executor
    .toLowerCase()
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * "Set up SpecKit" form, shown when an issue isn't a SpecKit feature yet.
 * Mirrors the spec-intake repo/executor pickers, then creates the persistent
 * feature workspace (branch == feature slug) with the `.specify/` scaffold.
 */
export function SpecKitSetup({
  projectId,
  issueId,
  onCreated,
}: SpecKitSetupProps) {
  const { profiles, config } = useUserSystem();
  const {
    executorConfig,
    effectiveExecutor,
    selectedVariant,
    executorOptions,
    variantOptions,
    setExecutor,
    setVariant,
  } = useExecutorConfig({
    profiles,
    lastUsedConfig: config?.executor_profile
      ? { executor: config.executor_profile.executor, variant: null }
      : null,
    configExecutorProfile: config?.executor_profile,
  });

  const [candidates, setCandidates] = useState<CandidateRepo[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(
    new Set()
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [defaults, repos] = await Promise.all([
          getProjectRepoDefaults(projectId),
          repoApi.list(),
        ]);
        if (cancelled) return;
        const repoById = new Map<string, Repo>(repos.map((r) => [r.id, r]));
        let list: CandidateRepo[];
        if (defaults && defaults.length > 0) {
          list = defaults
            .map((d) => ({
              repoId: d.repo_id,
              name: repoById.get(d.repo_id)?.display_name ?? d.repo_id,
              targetBranch: d.target_branch,
            }))
            .filter((c) => c.targetBranch.trim().length > 0);
        } else {
          list = repos
            .filter((r) => (r.default_target_branch ?? '').trim().length > 0)
            .map((r) => ({
              repoId: r.id,
              name: r.display_name,
              targetBranch: r.default_target_branch as string,
            }));
        }
        setCandidates(list);
        setSelectedRepoIds(new Set(list.map((c) => c.repoId)));
      } catch (e) {
        if (!cancelled) {
          console.error('[SpecKitSetup] Failed to load repos:', e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggleRepo = useCallback((repoId: string) => {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  }, []);

  const selectedRepos: WorkspaceRepoInput[] = useMemo(
    () =>
      candidates
        .filter((c) => selectedRepoIds.has(c.repoId))
        .map((c) => ({ repo_id: c.repoId, target_branch: c.targetBranch })),
    [candidates, selectedRepoIds]
  );

  const canCreate =
    !creating && selectedRepos.length > 0 && !!executorConfig;

  const handleCreate = useCallback(async () => {
    if (!canCreate || !executorConfig) return;
    setCreating(true);
    setError(null);
    try {
      const res = await specKitApi.createFeature({
        issue_id: issueId,
        repos: selectedRepos,
        executor_config: executorConfig,
      });
      onCreated(res.workspace.id);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Failed to set up the SpecKit feature.'
      );
    } finally {
      setCreating(false);
    }
  }, [canCreate, executorConfig, issueId, selectedRepos, onCreated]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-base p-double">
      <header className="space-y-half">
        <h2 className="text-lg font-semibold text-high">
          Set up SpecKit for this issue
        </h2>
        <p className="text-sm text-low">
          Creates a feature workspace on a dedicated branch and provisions the{' '}
          <span className="font-mono">.specify/</span> scaffold. Artifacts are
          committed alongside the code.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-half">
        <label className="text-xs text-low">Agent</label>
        <select
          value={effectiveExecutor ?? ''}
          disabled={creating}
          onChange={(e) => setExecutor(e.target.value as BaseCodingAgent)}
          className="rounded-sm border bg-panel/40 px-half py-half text-sm text-high disabled:opacity-50"
        >
          {executorOptions.map((exec) => (
            <option key={exec} value={exec}>
              {prettyExecutor(exec)}
            </option>
          ))}
        </select>
        {variantOptions.length > 1 && (
          <select
            value={selectedVariant ?? ''}
            disabled={creating}
            onChange={(e) => setVariant(e.target.value || null)}
            className="rounded-sm border bg-panel/40 px-half py-half text-sm text-high disabled:opacity-50"
          >
            {variantOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="space-y-half">
        <div className="text-xs text-low">Repositories</div>
        {candidates.length === 0 ? (
          <p className="text-xs text-low">
            No repositories with a default branch are configured for this
            project.
          </p>
        ) : (
          candidates.map((c) => (
            <label
              key={c.repoId}
              className="flex items-center gap-half text-sm text-high"
            >
              <input
                type="checkbox"
                checked={selectedRepoIds.has(c.repoId)}
                disabled={creating}
                onChange={() => toggleRepo(c.repoId)}
              />
              {c.name}
              <span className="text-xs text-low">({c.targetBranch})</span>
            </label>
          ))
        )}
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <button
        type="button"
        disabled={!canCreate}
        onClick={() => void handleCreate()}
        className="inline-flex w-fit items-center gap-half rounded-sm bg-brand px-double py-half text-sm font-medium text-white disabled:opacity-50"
      >
        {creating ? (
          <CircleNotchIcon className="size-icon-sm animate-spin" />
        ) : (
          <RocketLaunchIcon className="size-icon-sm" weight="fill" />
        )}
        {creating ? 'Setting up…' : 'Create SpecKit feature'}
      </button>
    </div>
  );
}
