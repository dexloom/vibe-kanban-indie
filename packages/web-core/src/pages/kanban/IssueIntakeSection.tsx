import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
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
  /** The issue's current title (header) — used as the brief to expand. */
  title: string;
  /** The issue's current description — appended to the brief for context. */
  description: string | null;
  /** Disabled when the dialog is submitting the card. */
  disabled?: boolean;
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
 * "Generate spec" intake controls for the New Issue dialog (create mode). Takes
 * the issue's own title + description as the brief, lets the user pick agent
 * parameters + repos, and runs a coding agent that expands it into a
 * development-ready title + spec. Synchronous (spinner) — overwrites the dialog's
 * title and description on success via `onGenerated`.
 */
export function IssueIntakeSection({
  projectId,
  title,
  description,
  disabled,
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

  // The brief is the issue's own header + description. Headed runs the read-only
  // spec step headless server-side, so every executor (including Claude Code
  // Headed) is selectable — the choice is the agent that later generates code.
  const brief = useMemo(() => {
    const header = title.trim();
    const body = (description ?? '').trim();
    return body ? `${header}\n\n${body}` : header;
  }, [title, description]);

  const [candidates, setCandidates] = useState<CandidateRepo[]>([]);
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(
    new Set()
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
    !isGenerating &&
    title.trim().length > 0 &&
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
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-half text-sm font-medium text-high"
      >
        {expanded ? (
          <CaretDownIcon className="size-icon-sm" weight="bold" />
        ) : (
          <CaretRightIcon className="size-icon-sm" weight="bold" />
        )}
        Spec
      </button>

      {expanded && (
        <>
          <p className="text-xs text-low">
            Uses the title and description above as the brief; an agent explores
            the selected repos and rewrites them into a full technical task.
          </p>

          {title.trim().length === 0 && (
            <p className="text-xs text-low">
              Add a title (and optionally a description) above to use as the
              brief.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-half">
            <label className="text-xs text-low">Agent</label>
            <select
              value={effectiveExecutor ?? ''}
              disabled={disabled || isGenerating}
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
