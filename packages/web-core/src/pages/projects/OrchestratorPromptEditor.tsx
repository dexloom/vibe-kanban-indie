import { useCallback, useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi } from '@/shared/lib/api';
import { refreshShapeSource } from '@/shared/lib/electric/collections';
import { PROJECTS_SHAPE } from 'shared/remote-types';
import { useSelectedOrgId } from '@/shared/stores/useOrganizationStore';
import type { ResolvedOrchestratorPromptResponse } from 'shared/types';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface OrchestratorPromptEditorProps {
  /** Optional — defaults to the route param. The route file passes
   * `projectId` from `useParams` directly so the editor stays a leaf
   * component (no router coupling needed for unit tests). */
  projectId?: string;
}

export function OrchestratorPromptEditor({
  projectId: projectIdProp,
}: OrchestratorPromptEditorProps = {}) {
  const params = useParams({ strict: false });
  const projectId = projectIdProp ?? (params.projectId as string | undefined);
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();
  const selectedOrgId = useSelectedOrgId();

  const [draft, setDraft] = useState<string>('');
  const [initialRaw, setInitialRaw] = useState<string>('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [resolved, setResolved] =
    useState<ResolvedOrchestratorPromptResponse | null>(null);

  // Fetch BOTH raw (for the textarea) and resolve (for the badge) in
  // parallel on mount. Both are needed at the same time — the raw
  // seeds the textarea, the resolve populates the "Inherited from"
  // badge / "Using default behavior" footer.
  useEffect(() => {
    if (!projectId) return;
    setIsLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const [raw, resolve] = await Promise.all([
          projectsApi.getOrchestratorPrompt(projectId),
          projectsApi.resolveOrchestratorPrompt(projectId),
        ]);
        if (cancelled) return;
        setDraft(raw.orchestrator_prompt);
        setInitialRaw(raw.orchestrator_prompt);
        setResolved(resolve);
        setIsLoading(false);
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(e instanceof Error ? e.message : 'Failed to load');
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const save = useCallback(async () => {
    if (!projectId) return;
    setSaveState('saving');
    setErrorMessage(null);
    try {
      const updated = await projectsApi.putOrchestratorPrompt(projectId, {
        orchestrator_prompt: draft,
      });
      setInitialRaw(updated.orchestrator_prompt);
      // Re-resolve so the inherited-from badge updates (the prompt may
      // have been empty and now resolves to itself).
      try {
        const reResolved = await projectsApi.resolveOrchestratorPrompt(
          projectId
        );
        setResolved(reResolved);
      } catch {
        // Non-fatal — the badge would just be stale until next mount.
      }
      setSaveState('saved');
      // Invalidate the sidebar/tree project cache so the brand-coloured
      // dot reflects the new `has_orchestrator_prompt` value.
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      // The sidebar tree reads `hasOrchestratorPrompt` from the Electric
      // PROJECTS_SHAPE (not react-query), so the "Orchestrator prompt"
      // node would not appear until the next slow fallback poll. Force
      // a refresh to surface it immediately. Matches persistIssues /
      // KanbanContainer's refreshShapeSource pattern.
      if (selectedOrgId) {
        try {
          refreshShapeSource(PROJECTS_SHAPE, {
            organization_id: selectedOrgId,
          });
        } catch {
          // Non-fatal — next shape sync heals it.
        }
      }
      // Brief reset to idle — UI feedback that the save completed.
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Failed to save');
      setSaveState('error');
    }
  }, [projectId, draft, queryClient, selectedOrgId]);

  const clear = useCallback(async () => {
    if (!projectId) return;
    setDraft('');
    setSaveState('saving');
    setErrorMessage(null);
    // UX trade-off (documented, accepted): we clear the textarea
    // BEFORE the PUT round-trips so the operator gets instant
    // feedback. If the PUT fails, the textarea stays cleared (the
    // server may or may not have cleared — depends on whether the
    // failure was a transport error before vs. after the row write).
    // The error toast re-renders the failure; the operator can retry.
    // Single-dev tool, low-frequency action — not worth a two-phase
    // optimistic commit.
    try {
      const updated = await projectsApi.putOrchestratorPrompt(projectId, {
        orchestrator_prompt: '',
      });
      setInitialRaw(updated.orchestrator_prompt);
      try {
        const reResolved = await projectsApi.resolveOrchestratorPrompt(
          projectId
        );
        setResolved(reResolved);
      } catch {
        // Non-fatal.
      }
      setSaveState('saved');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (selectedOrgId) {
        try {
          refreshShapeSource(PROJECTS_SHAPE, {
            organization_id: selectedOrgId,
          });
        } catch {
          // Non-fatal — next shape sync heals it.
        }
      }
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : 'Failed to clear');
      setSaveState('error');
    }
  }, [projectId, queryClient, selectedOrgId]);

  if (!projectId) {
    return (
      <div className="p-base text-sm text-low">
        {t('orchestratorPromptEditor.missingProjectId', 'No project id in route.')}
      </div>
    );
  }

  const isDirty = draft !== initialRaw;
  const rawIsEmpty = initialRaw.trim().length === 0;

  // ADR-016: the resolve endpoint is the single source of truth for
  // inheritance. When this row's raw prompt is empty and the resolver
  // says "ancestor", we show "Inherited from an ancestor project". When
  // resolve says "default", we show "Using default behavior".
  // `source_project_id` should always be set for `ancestor`; keep the check as
  // defense-in-depth against malformed or stale API responses.
  const showInherited =
    rawIsEmpty &&
    resolved?.source === 'ancestor' &&
    resolved.source_project_id !== null;
  const showDefault = rawIsEmpty && resolved?.source === 'default';

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-base p-double">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-high">
          {t('orchestratorPromptEditor.title', 'Orchestrator prompt')}
        </h1>
        <p className="text-sm text-low">
          {t(
            'orchestratorPromptEditor.subtitle',
            'Read by the orchestrator at the start of every tick. Edits apply live — no restart.'
          )}
        </p>
      </header>

      {showInherited && (
        <div
          className="rounded-md border border-brand/40 bg-brand/10 px-base py-2 text-sm text-high"
          data-testid="orchestrator-prompt-inherited-from"
        >
          {t(
            'orchestratorPromptEditor.inheritedFrom',
            'Inherited from an ancestor project'
          )}
        </div>
      )}
      {showDefault && (
        <div
          className="rounded-md border border-tertiary bg-secondary px-base py-2 text-sm text-low"
          data-testid="orchestrator-prompt-using-default"
        >
          {t(
            'orchestratorPromptEditor.usingDefault',
            'Using default behavior'
          )}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (saveState === 'saved') setSaveState('idle');
        }}
        disabled={isLoading}
        rows={18}
        data-testid="orchestrator-prompt-textarea"
        className="font-ibm-plex-mono w-full resize-y rounded border bg-secondary px-base py-2 text-base text-normal placeholder:text-low focus:outline-none focus:ring-1 focus:ring-brand"
        placeholder={t(
          'orchestratorPromptEditor.placeholder',
          'Be terse. Use sparse commits. Always run the test suite before committing.'
        )}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!isDirty || saveState === 'saving'}
          data-testid="orchestrator-prompt-save"
          className="rounded bg-brand px-base py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saveState === 'saving'
            ? t('orchestratorPromptEditor.saving', 'Saving…')
            : t('orchestratorPromptEditor.save', 'Save')}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={saveState === 'saving' || rawIsEmpty}
          data-testid="orchestrator-prompt-clear"
          className="rounded border bg-secondary px-base py-1.5 text-sm text-low transition-colors hover:text-normal disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('orchestratorPromptEditor.clear', 'Clear')}
        </button>
        <div className="ml-auto text-2xs text-low" data-testid="orchestrator-prompt-status">
          {saveState === 'saved' && (
            <span className="text-success">
              {t('orchestratorPromptEditor.saved', 'Saved')}
            </span>
          )}
          {saveState === 'error' && (
            <span className="text-error">{errorMessage ?? 'Error'}</span>
          )}
        </div>
      </div>
    </section>
  );
}
