import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseCodingAgent,
  type Repo,
  type WorkspaceRepoInput,
} from 'shared/types';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useExecutorConfig } from '@/shared/hooks/useExecutorConfig';
import { getProjectRepoDefaults } from '@/shared/hooks/useProjectRepoDefaults';
import { repoApi, specApi, ApiError } from '@/shared/lib/api';

interface IssueIntakeSectionProps {
  projectId: string;
  /** Disabled when the dialog is submitting the card. */
  disabled?: boolean;
  /** True when running over a remote relay (feature is local-only). */
  relayDisabled?: boolean;
  /** Called with the generated spec + provenance to store in extension_metadata. */
  onGenerated: (
    title: string,
    description: string,
    intakeMetadata: unknown
  ) => void;
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
 * "Generate spec" intake controls for the New Issue dialog (create mode). Lets
 * the user type a rough brief, pick agent parameters + repos, and run a coding
 * agent that expands it into a development-ready title + spec. Synchronous
 * (spinner) — fills the dialog fields on success via `onGenerated`.
 */
export function IssueIntakeSection({
  projectId,
  disabled,
  relayDisabled,
  onGenerated,
}: IssueIntakeSectionProps) {
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

  // Interactive executors can't run headless here; mirror the server allowlist.
  const allowedExecutors = useMemo(
    () =>
      executorOptions.filter((e) => e !== BaseCodingAgent.CLAUDE_CODE_HEADED),
    [executorOptions]
  );

  const [brief, setBrief] = useState('');
  const [candidates, setCandidates] = useState<CandidateRepo[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(
    new Set()
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Used to ignore a stale in-flight response if a newer request is started.
  const requestTokenRef = useRef(0);

  // Load the project's default repos (with branches) + repo names for display.
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
          console.error('[IssueIntakeSection] Failed to load repos:', e);
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

  const canGenerate =
    !disabled &&
    !relayDisabled &&
    !isGenerating &&
    brief.trim().length > 0 &&
    selectedRepos.length > 0 &&
    !!executorConfig;

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !executorConfig) return;
    const token = ++requestTokenRef.current;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await specApi.generate({
        project_id: projectId,
        brief: brief.trim(),
        executor_config: executorConfig,
        repos: selectedRepos,
      });
      // Ignore if a newer request superseded this one.
      if (token !== requestTokenRef.current) return;
      onGenerated(result.title, result.description, result.intake_metadata);
    } catch (e) {
      if (token !== requestTokenRef.current) return;
      const message =
        e instanceof ApiError
          ? e.message
          : 'Failed to generate spec. Please try again.';
      setError(message);
    } finally {
      if (token === requestTokenRef.current) setIsGenerating(false);
    }
  }, [
    canGenerate,
    executorConfig,
    projectId,
    brief,
    selectedRepos,
    onGenerated,
  ]);

  return (
    <div className="p-base border-t space-y-base">
      <div>
        <div className="text-sm font-medium text-high">
          Generate spec from a brief
        </div>
        <p className="text-xs text-low mt-half">
          Describe the task in a line or two; an agent explores the selected
          repos and drafts a full technical task into the title and description.
        </p>
      </div>

      {relayDisabled ? (
        <p className="text-xs text-low">
          Spec generation runs locally only — it isn’t available over a remote
          connection.
        </p>
      ) : (
        <>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={disabled || isGenerating}
            rows={2}
            placeholder="e.g. add exponential-backoff retry to the webhook sender"
            className="w-full rounded-sm border bg-panel/40 px-half py-half text-sm text-high placeholder:text-low disabled:opacity-50"
          />

          <div className="flex flex-wrap items-center gap-half">
            <label className="text-xs text-low">Agent</label>
            <select
              value={effectiveExecutor ?? ''}
              disabled={disabled || isGenerating}
              onChange={(e) => setExecutor(e.target.value as BaseCodingAgent)}
              className="rounded-sm border bg-panel/40 px-half py-half text-sm text-high disabled:opacity-50"
            >
              {allowedExecutors.map((exec) => (
                <option key={exec} value={exec}>
                  {prettyExecutor(exec)}
                </option>
              ))}
            </select>

            {variantOptions.length > 1 && (
              <select
                value={selectedVariant ?? ''}
                disabled={disabled || isGenerating}
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
            <div className="text-xs text-low">Repos to explore</div>
            {candidates.length === 0 ? (
              <p className="text-xs text-low">
                No repositories with a default branch are available for this
                project.
              </p>
            ) : (
              <div className="flex flex-wrap gap-base">
                {candidates.map((c) => (
                  <label
                    key={c.repoId}
                    className="flex items-center gap-half text-sm text-normal"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRepoIds.has(c.repoId)}
                      disabled={disabled || isGenerating}
                      onChange={() => toggleRepo(c.repoId)}
                    />
                    <span>{c.name}</span>
                    <span className="text-xs text-low">({c.targetBranch})</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-error">{error}</p>}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="rounded-sm border px-base py-half text-sm font-medium text-high hover:bg-panel/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? 'Generating spec…' : 'Generate spec'}
          </button>
        </>
      )}
    </div>
  );
}
