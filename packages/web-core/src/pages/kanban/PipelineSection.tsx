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
  composePipelineBlock,
  extractManualLines,
  type PipelineStage,
} from '@/shared/lib/pipeline/cardPipeline';
import { useDefaultPipelineId } from '@/shared/stores/useUiPreferencesStore';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vibe/ui/components/Select';
import { cn } from '@/shared/lib/utils';

export interface PipelineSelection {
  /** Selected pipeline ids. Single-select now, so at most one entry. */
  pipelineIds: string[];
  /** Ticked stage ids (the selected pipeline's default-enabled stages). */
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
   * Seed data for editing an existing card. When provided, the section seeds
   * from it verbatim instead of applying the create-mode default.
   * `null`/`undefined` selects the create-mode default behavior.
   */
  initialSelection?: PipelineInitialSelection | null;
  /** Emits the current selection whenever it changes. */
  onChange: (selection: PipelineSelection) => void;
}

/**
 * Per-card "Pipeline" control, used both in the New Issue dialog (create
 * mode) and when editing an existing card. Single-select dropdown over the
 * file-based pipelines; the chosen pipeline's stages are listed as
 * checkboxes so the operator can tick exactly which apply, and those ticked
 * stages are composed into a `## Pipeline` block (editable in the textbox).
 * The last pipeline choice is remembered (localStorage) as the default for
 * the next issue. Because there is only ever one pipeline selected, the
 * block reflects the current ticks 1:1 — no cross-pipeline merging, and a
 * pipeline change fully replaces the block (manual edits persist only until
 * the next pipeline change; stage/executor tweaks preserve them).
 */
export function PipelineSection({
  profiles,
  disabled,
  expanded: expandedProp,
  initialSelection,
  onChange,
}: PipelineSectionProps) {
  const { t } = useTranslation('common');
  const [rememberedDefaultId, setRememberedDefaultId] = useDefaultPipelineId();
  const agents = useMemo(
    () => (profiles ? Object.keys(profiles).sort() : []),
    [profiles]
  );

  const hasInitialSelection = initialSelection != null;

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [expanded, setExpanded] = useState(expandedProp ?? true);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialSelection?.pipelineIds[0] ?? null
  );
  // Ticked stage ids for the selected pipeline. Seeded from provenance in edit
  // mode; reset to the pipeline's default-enabled stages whenever the pipeline
  // changes.
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(initialSelection?.enabledIds ?? [])
  );
  const [executor, setExecutor] = useState<string | null>(
    initialSelection?.executor ?? null
  );
  const [text, setText] = useState(initialSelection?.block ?? '');

  // Create-mode default applied once pipelines load.
  const appliedCreateDefaultRef = useRef(hasInitialSelection);
  // Skip the very first recompose in edit mode so opening a card never
  // rewrites its existing block before interaction.
  const skipFirstRecomposeRef = useRef(hasInitialSelection);
  // When set, the next recompose discards the previous block entirely (fresh).
  // Set on pipeline change so the block reflects ONLY the new selection.
  const fullReplaceRef = useRef(false);
  // Suppress emits until the operator actually interacts (edit mode), so
  // opening a card never persists a write.
  const interactedRef = useRef(!hasInitialSelection);

  const selectedPipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId]
  );

  const allFragments = useMemo(
    () =>
      new Set(pipelines.flatMap((p) => p.stages.map((s) => s.prompt_fragment))),
    [pipelines]
  );

  const defaultStageIds = useCallback(
    (pipeline: Pipeline | null): Set<string> =>
      new Set(
        (pipeline?.stages ?? [])
          .filter((s) => s.default_enabled)
          .map((s) => s.id)
      ),
    []
  );

  // Fetch pipelines once. In create mode, default the dropdown to the
  // remembered default (else 'basic', else first) and tick its default stages;
  // the recompose effect builds the block from that selection.
  useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setPipelines(list);
        if (appliedCreateDefaultRef.current) return;
        appliedCreateDefaultRef.current = true;
        const remembered = rememberedDefaultId
          ? list.find((p) => p.id === rememberedDefaultId)
          : null;
        const def =
          remembered ?? list.find((p) => p.id === 'basic') ?? list[0] ?? null;
        if (!def) return;
        setSelectedId(def.id);
        setEnabledIds(defaultStageIds(def));
        fullReplaceRef.current = true;
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recompose the block whenever the selection settles. A pipeline change sets
  // `fullReplaceRef` so the block is rebuilt from scratch — only the currently
  // ticked stages of the one selected pipeline appear, with no carry-over.
  // Stage toggles and executor changes are non-destructive: manual lines typed
  // into the textbox survive.
  useEffect(() => {
    if (skipFirstRecomposeRef.current) {
      skipFirstRecomposeRef.current = false;
      return;
    }
    const fullReplace = fullReplaceRef.current;
    fullReplaceRef.current = false;
    setText((prev) =>
      composePipelineBlock(selectedPipeline, enabledIds, '', executor, {
        previousBlock: fullReplace ? null : prev,
        knownStageFragments: allFragments,
      })
    );
  }, [selectedPipeline, enabledIds, executor, allFragments]);

  // Notify parent of the effective selection whenever it settles.
  const emittedRef = useRef('');
  useEffect(() => {
    if (!interactedRef.current) return;
    const block = text.trim();
    const signature = `${selectedId ?? ''}|${[...enabledIds]
      .slice()
      .sort()
      .join(',')}|${executor ?? ''}|${block}`;
    if (emittedRef.current === signature) return;
    emittedRef.current = signature;
    const customText = extractManualLines(block, allFragments).join('\n');
    onChange({
      pipelineIds: selectedId ? [selectedId] : [],
      enabledIds: [...enabledIds],
      executor,
      customText,
      block,
    });
  }, [selectedId, enabledIds, executor, text, allFragments, onChange]);

  const handleSelectPipeline = useCallback(
    (id: string) => {
      interactedRef.current = true;
      setSelectedId(id);
      setRememberedDefaultId(id);
      const p = pipelines.find((x) => x.id === id) ?? null;
      setEnabledIds(defaultStageIds(p));
      fullReplaceRef.current = true;
    },
    [pipelines, defaultStageIds, setRememberedDefaultId]
  );

  const handleToggleStep = useCallback((id: string) => {
    interactedRef.current = true;
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleExecutorChange = useCallback((value: string) => {
    interactedRef.current = true;
    setExecutor(value || null);
  }, []);

  const resetToGenerated = useCallback(() => {
    interactedRef.current = true;
    setText(composePipelineBlock(selectedPipeline, enabledIds, '', executor));
  }, [selectedPipeline, enabledIds, executor]);

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
              {t('cardPipeline.pipelineLabel')}
            </label>
            <Select
              value={selectedId ?? ''}
              onValueChange={handleSelectPipeline}
              disabled={disabled || pipelines.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('cardPipeline.pipelinePlaceholder')}
                />
              </SelectTrigger>
              <SelectContent>
                {selectedId && !selectedPipeline ? (
                  <SelectItem value={selectedId}>
                    {t('cardPipeline.noPipeline')}
                  </SelectItem>
                ) : null}
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex flex-col">
                      <span>{p.name}</span>
                      {p.description ? (
                        <span className="text-xs text-low">
                          {p.description}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                onChange={(e) => handleExecutorChange(e.target.value)}
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

          {selectedPipeline && selectedPipeline.stages.length > 0 ? (
            <div className="flex flex-col gap-half">
              {selectedPipeline.stages.map((step) => (
                <label
                  key={step.id}
                  className="flex items-center gap-half text-sm text-normal"
                >
                  <input
                    type="checkbox"
                    checked={enabledIds.has(step.id)}
                    disabled={disabled}
                    onChange={() => handleToggleStep(step.id)}
                  />
                  <span>
                    {step.label}
                    {step.heavy ? (
                      <span className="ml-half rounded-sm border px-half text-xs text-low">
                        {t('cardPipeline.heavyBadge')}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          ) : selectedPipeline ? (
            <p className="text-xs text-low">{t('cardPipeline.noSteps')}</p>
          ) : null}

          <div className="space-y-half">
            <div className="flex items-center justify-between">
              <label className="text-xs text-low">
                {t('cardPipeline.addonLabel')}
              </label>
              <button
                type="button"
                onClick={resetToGenerated}
                disabled={disabled || !selectedPipeline}
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
