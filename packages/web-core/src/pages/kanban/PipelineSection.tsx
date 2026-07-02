import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleIcon,
} from '@phosphor-icons/react';
import type { Pipeline } from 'shared/types';
import { pipelinesApi } from '@/shared/lib/api';
import {
  canonicalStageOrder,
  composePipelineBlock,
  extractManualLines,
  orderedEnabledStages,
  type PipelineStage,
} from '@/shared/lib/pipeline/cardPipeline';
import { cn } from '@/shared/lib/utils';

export interface PipelineSelection {
  /** Selected pipeline ids (additive; empty when nothing is chosen). */
  pipelineIds: string[];
  /** Ticked stage ids, in canonical merge order. */
  enabledIds: string[];
  /** Pinned execution agent (`BaseCodingAgent` key) or null for the default. */
  executor: string | null;
  /** The operator's manual/extra text, extracted from the composed block. */
  customText: string;
  /** The composed `## Pipeline` markdown block (empty when nothing selected). */
  block: string;
}

export interface PipelineInitialSelection {
  /** Pipeline ids read from the card's `extension_metadata.pipeline` provenance. */
  pipelineIds: string[];
  /** Ticked stage ids read from provenance. */
  enabledIds: string[];
  /** Pinned execution agent read from provenance. */
  executor: string | null;
  /** The existing description's delimited `## Pipeline` block (incl. delimiters, or ''). */
  block: string;
}

interface PipelineSectionProps {
  /** Available executor profiles, keyed by `BaseCodingAgent`. */
  profiles: Record<string, unknown> | null;
  /** Disabled while the card is being submitted. */
  disabled?: boolean;
  /** Whether the section starts expanded. Defaults to `true`. */
  expanded?: boolean;
  /**
   * Seed data for editing an existing card. When provided (even with empty
   * arrays/block, for a card that has no pipeline), the section seeds from it
   * verbatim instead of defaulting to `basic`. `null`/`undefined` selects the
   * create-mode default behavior.
   */
  initialSelection?: PipelineInitialSelection | null;
  /** Emits the current selection whenever it changes. */
  onChange: (selection: PipelineSelection) => void;
}

/**
 * Per-card "Pipeline" control, used both in the New Issue dialog (create
 * mode) and when editing an existing card. Fetches the file-based pipelines,
 * lets the operator additively pick one or more and tick which of their
 * (deduped, canonically-ordered) stages apply, pin an execution agent, and
 * edit the composed prompt block. Recompose is non-destructive: any manual
 * lines the operator typed into the block survive further tick/selection
 * changes. Emits the result so the container can append it to the card
 * description (and mirror provenance into `extension_metadata.pipeline`).
 */
export function PipelineSection({
  profiles,
  disabled,
  expanded: expandedProp,
  initialSelection,
  onChange,
}: PipelineSectionProps) {
  const { t } = useTranslation('common');
  const agents = useMemo(
    () => (profiles ? Object.keys(profiles).sort() : []),
    [profiles]
  );

  const hasInitialSelection = initialSelection != null;

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [expanded, setExpanded] = useState(expandedProp ?? true);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    () => initialSelection?.pipelineIds ?? []
  );
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(initialSelection?.enabledIds ?? [])
  );
  // Pinned execution agent (null = let the orchestrator pick its default).
  const [executor, setExecutor] = useState<string | null>(
    initialSelection?.executor ?? null
  );
  // The composed block, incl. delimiters. Regenerated (non-destructively)
  // whenever the selection/ticks/executor change.
  const [text, setText] = useState(initialSelection?.block ?? '');

  // Whether the create-mode `basic`-default selection has already been
  // applied. Not relevant (pre-satisfied) when seeded from initialSelection.
  const appliedCreateDefaultRef = useRef(hasInitialSelection);
  // Whether initialSelection.enabledIds has been applied as the seed. After
  // this, ticks reset to the default-enabled union on further selection
  // changes (matches create-mode behavior).
  const appliedInitialEnabledRef = useRef(!hasInitialSelection);
  // Skip the recompose effect's very first run when seeded in edit mode, so
  // opening a card never rewrites its existing block before interaction.
  const skipFirstRecomposeRef = useRef(hasInitialSelection);
  // Suppress onChange emits until the operator actually interacts, in edit
  // mode, so opening a card never persists a write (e.g. auto-appending
  // Basic onto a card that had no pipeline).
  const interactedRef = useRef(!hasInitialSelection);

  // Fetch available pipelines once; default the picker to `basic` (else
  // first) only when there's no seeded selection (create mode).
  useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setPipelines(list);
        if (!appliedCreateDefaultRef.current) {
          appliedCreateDefaultRef.current = true;
          const def = list.find((p) => p.id === 'basic') ?? list[0] ?? null;
          setSelectedIds(def ? [def.id] : []);
        }
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedPipelines = useMemo(
    () =>
      selectedIds
        .map((id) => pipelines.find((p) => p.id === id))
        .filter((p): p is Pipeline => p != null),
    [pipelines, selectedIds]
  );

  const orderedSteps = useMemo(
    () => canonicalStageOrder(selectedPipelines),
    [selectedPipelines]
  );

  // Fragments of ALL available pipelines' stages (not just selected ones),
  // so a generated stage line is recognised and dropped when its stage or
  // whole pipeline is deselected, instead of being stranded as "manual".
  const allFragments = useMemo(
    () =>
      new Set(pipelines.flatMap((p) => p.stages.map((s) => s.prompt_fragment))),
    [pipelines]
  );

  // Seed enabled ticks: `initialSelection.enabledIds` verbatim once (edit
  // mode), then the default-enabled union of the selected pipelines whenever
  // the pipeline selection changes thereafter.
  useEffect(() => {
    if (!appliedInitialEnabledRef.current) {
      appliedInitialEnabledRef.current = true;
      return;
    }
    setEnabledIds(
      new Set(
        selectedPipelines.flatMap((p) =>
          p.stages.filter((s) => s.default_enabled).map((s) => s.id)
        )
      )
    );
    // Deliberately keyed on `selectedIds` only: this reseeds ticks whenever
    // the pipeline *selection* changes, not whenever `pipelines` reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // Non-destructive recompose: read the previous text via the functional
  // updater (no `text` dep, so this can't loop) and preserve any manual
  // lines already present in it.
  useEffect(() => {
    if (skipFirstRecomposeRef.current) {
      skipFirstRecomposeRef.current = false;
      return;
    }
    setText((prev) =>
      composePipelineBlock(selectedPipelines, enabledIds, '', executor, {
        previousBlock: prev,
        knownStageFragments: allFragments,
      })
    );
  }, [selectedPipelines, enabledIds, executor, allFragments]);

  // Notify the parent of the effective selection whenever it settles.
  const emittedRef = useRef<string>('');
  useEffect(() => {
    if (!interactedRef.current) return;
    const block = text.trim();
    const signature = `${[...selectedIds].sort().join(',')}|${[...enabledIds].sort().join(',')}|${executor ?? ''}|${block}`;
    if (emittedRef.current === signature) return;
    emittedRef.current = signature;
    const customText = extractManualLines(block, allFragments).join('\n');
    onChange({
      pipelineIds: selectedIds,
      enabledIds: orderedEnabledStages(selectedPipelines, enabledIds).map(
        (s) => s.id
      ),
      executor,
      customText,
      block,
    });
  }, [
    selectedIds,
    selectedPipelines,
    enabledIds,
    executor,
    text,
    allFragments,
    onChange,
  ]);

  const togglePipeline = useCallback((id: string) => {
    interactedRef.current = true;
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }, []);

  const toggleStep = useCallback((id: string) => {
    interactedRef.current = true;
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetToGenerated = useCallback(() => {
    interactedRef.current = true;
    setText(composePipelineBlock(selectedPipelines, enabledIds, '', executor));
  }, [selectedPipelines, enabledIds, executor]);

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
        {t('cardPipeline.title')}
      </button>

      {expanded && (
        <>
          <p className="text-xs text-low">{t('cardPipeline.description')}</p>

          <div className="space-y-half">
            <label className="text-xs text-low block">
              {t('cardPipeline.pipelinesLabel')}
            </label>
            <div className="flex flex-col gap-half">
              {pipelines.map((p) => (
                <label
                  key={p.id}
                  className="flex items-start gap-half text-sm text-normal"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    disabled={disabled}
                    onChange={() => togglePipeline(p.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block">{p.name}</span>
                    {p.description && (
                      <span className="block text-xs text-low">
                        {p.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-low">
              {t('cardPipeline.pipelinesHelper')}
            </p>
          </div>

          {agents.length > 0 && (
            <div className="space-y-half">
              <label
                htmlFor="pipeline-agent"
                className="text-xs text-low block"
              >
                {t('cardPipeline.agentLabel')}
              </label>
              <select
                id="pipeline-agent"
                value={executor ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  interactedRef.current = true;
                  setExecutor(e.target.value || null);
                }}
                className="w-full rounded-sm border bg-panel/40 px-half py-half text-sm text-high disabled:opacity-50"
              >
                <option value="">{t('cardPipeline.agentDefault')}</option>
                {agents.map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
              <p className="text-xs text-low">
                {t('cardPipeline.agentHelper')}
              </p>
            </div>
          )}

          {selectedPipelines.length > 0 && orderedSteps.length === 0 ? (
            <p className="text-xs text-low">{t('cardPipeline.noSteps')}</p>
          ) : orderedSteps.length > 0 ? (
            <div className="flex flex-col gap-half">
              {orderedSteps.map((step) => (
                <label
                  key={step.id}
                  className="flex items-center gap-half text-sm text-normal"
                >
                  <input
                    type="checkbox"
                    checked={enabledIds.has(step.id)}
                    disabled={disabled}
                    onChange={() => toggleStep(step.id)}
                  />
                  <span>{step.label}</span>
                </label>
              ))}
            </div>
          ) : null}

          <div className="space-y-half">
            <div className="flex items-center justify-between">
              <label className="text-xs text-low">
                {t('cardPipeline.addonLabel')}
              </label>
              <button
                type="button"
                onClick={resetToGenerated}
                disabled={disabled}
                className="text-xs text-brand hover:underline disabled:opacity-50"
              >
                {t('cardPipeline.resetToGenerated')}
              </button>
            </div>
            <textarea
              value={text}
              disabled={disabled}
              rows={6}
              onChange={(e) => {
                interactedRef.current = true;
                setText(e.target.value);
              }}
              placeholder={t('cardPipeline.addonPlaceholder')}
              className="w-full rounded-sm border bg-panel/40 px-half py-half text-sm text-high font-mono resize-y disabled:opacity-50"
            />
          </div>
        </>
      )}
    </div>
  );
}

export interface PipelineProgressProps {
  /** Parsed stage list (M), from `parsePipelineStages(description)`. */
  stages: PipelineStage[];
  /**
   * The workspace's live `current_pipeline_stage` (N), or `null` when the
   * execution agent hasn't reported a stage yet for the current run.
   */
  currentStage: number | null;
}

/**
 * Read-only "you are here" view of a card's pipeline progress, driven by the
 * active workspace's live `current_pipeline_stage` (N) against the stage
 * list parsed from the description (M). Rendered in the issue panel's edit
 * mode; purely presentational, never mutates anything.
 */
export function PipelineProgress({
  stages,
  currentStage,
}: PipelineProgressProps) {
  const { t } = useTranslation('common');

  if (stages.length === 0) return null;

  const total = stages.length;
  // Clamp gracefully when N > M (e.g. the pipeline was edited down after the
  // agent had already advanced past the new stage count): still show "N of
  // M", but treat every stage as done rather than indexing past the list.
  const clamped = currentStage !== null ? Math.min(currentStage, total) : null;
  const currentLabel =
    clamped !== null
      ? (stages.find((s) => s.index === clamped)?.label ?? '')
      : '';

  return (
    <div className="p-base border-t space-y-half">
      <p className="text-xs font-medium text-high">
        {t('cardPipeline.progressTitle')}
        {': '}
        {currentStage !== null
          ? t('cardPipeline.progressHeader', {
              n: currentStage,
              total,
              label: currentLabel,
            })
          : t('cardPipeline.progressNotStarted', { total })}
      </p>
      <ol className="flex flex-col gap-half">
        {stages.map((stage) => {
          const state: 'done' | 'current' | 'pending' =
            clamped === null
              ? 'pending'
              : stage.index < clamped
                ? 'done'
                : stage.index === clamped
                  ? 'current'
                  : 'pending';
          return (
            <li
              key={stage.index}
              className={cn(
                'flex items-center gap-half text-sm',
                state === 'done' && 'text-low',
                state === 'current' && 'text-high font-medium',
                state === 'pending' && 'text-low'
              )}
            >
              {state === 'done' ? (
                <CheckCircleIcon
                  className="size-icon-sm shrink-0 text-success"
                  weight="fill"
                />
              ) : state === 'current' ? (
                <ArrowRightIcon
                  className="size-icon-sm shrink-0 text-brand"
                  weight="bold"
                />
              ) : (
                <CircleIcon className="size-icon-sm shrink-0" />
              )}
              <span className={cn(state === 'done' && 'line-through')}>
                {stage.index}. {stage.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
