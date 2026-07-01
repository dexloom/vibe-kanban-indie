import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { Pipeline } from 'shared/types';
import { pipelinesApi } from '@/shared/lib/api';
import { composePipelineBlock } from '@/shared/lib/pipeline/cardPipeline';

export interface PipelineSelection {
  /** Chosen pipeline id, or null for "None". */
  pipelineId: string | null;
  /** Ticked stage ids, in pipeline order. */
  enabledIds: string[];
  /** Pinned execution agent (`BaseCodingAgent` key) or null for the default. */
  executor: string | null;
  /** The operator's free-text addition (may be empty). */
  customText: string;
  /** The composed `## Pipeline` markdown block (empty when nothing selected). */
  block: string;
}

interface PipelineSectionProps {
  /** Available executor profiles, keyed by `BaseCodingAgent`. */
  profiles: Record<string, unknown> | null;
  /** Disabled while the card is being submitted. */
  disabled?: boolean;
  /** Emits the current selection whenever it changes. */
  onChange: (selection: PipelineSelection) => void;
}

/**
 * Per-card "Pipeline" control for the New Issue dialog (create mode only).
 * Fetches the file-based pipelines, lets the operator pick one and tick which of
 * its stages apply (the "pipeline options"), pin an execution agent, and edit
 * the composed prompt block. Emits the result so the container can append it to
 * the card description (and mirror provenance into `extension_metadata.pipeline`).
 */
export function PipelineSection({
  profiles,
  disabled,
  onChange,
}: PipelineSectionProps) {
  const { t } = useTranslation('common');
  const agents = useMemo(
    () => (profiles ? Object.keys(profiles).sort() : []),
    [profiles]
  );

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(() => new Set());
  // Pinned execution agent (null = let the orchestrator pick its default).
  const [executor, setExecutor] = useState<string | null>(null);
  // The composed block, regenerated from the ticks until the operator edits it.
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);

  // Fetch available pipelines once; default the picker to `basic` (else first).
  useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setPipelines(list);
        const def = list.find((p) => p.id === 'basic') ?? list[0] ?? null;
        setPipelineId(def ? def.id : null);
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(
    () => pipelines.find((p) => p.id === pipelineId) ?? null,
    [pipelines, pipelineId]
  );
  const steps = useMemo(() => selected?.stages ?? [], [selected]);

  // Re-seed the ticks when the selected pipeline changes. Resets manual edits.
  useEffect(() => {
    setEnabledIds(
      new Set(steps.filter((s) => s.default_enabled).map((s) => s.id))
    );
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipelineId]);

  // Keep the textarea in sync with the ticks/agent until the operator takes over.
  useEffect(() => {
    if (dirty) return;
    setText(composePipelineBlock(selected, enabledIds, '', executor));
  }, [selected, enabledIds, executor, dirty]);

  // Notify the parent of the effective selection. `block` is the operator's
  // edited text when dirty, else the freshly composed block.
  const emittedRef = useRef<string>('');
  useEffect(() => {
    const block = dirty
      ? text.trim()
      : composePipelineBlock(selected, enabledIds, '', executor);
    const signature = `${pipelineId ?? ''}|${[...enabledIds].sort().join(',')}|${executor ?? ''}|${block}`;
    if (emittedRef.current === signature) return;
    emittedRef.current = signature;
    onChange({
      pipelineId,
      enabledIds: steps.filter((s) => enabledIds.has(s.id)).map((s) => s.id),
      executor,
      customText: dirty ? text : '',
      block,
    });
  }, [
    selected,
    pipelineId,
    steps,
    enabledIds,
    executor,
    text,
    dirty,
    onChange,
  ]);

  const toggleStep = useCallback((id: string) => {
    setEnabledIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const resetToCheckboxes = useCallback(() => {
    setDirty(false);
    setText(composePipelineBlock(selected, enabledIds, '', executor));
  }, [selected, enabledIds, executor]);

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
            <label
              htmlFor="pipeline-pipeline"
              className="text-xs text-low block"
            >
              {t('cardPipeline.pipelineLabel')}
            </label>
            <select
              id="pipeline-pipeline"
              value={pipelineId ?? ''}
              disabled={disabled}
              onChange={(e) => setPipelineId(e.target.value || null)}
              className="w-full rounded-sm border bg-panel/40 px-half py-half text-sm text-high disabled:opacity-50"
            >
              <option value="">{t('cardPipeline.pipelineNone')}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {selected?.description && (
              <p className="text-xs text-low">{selected.description}</p>
            )}
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
                onChange={(e) => setExecutor(e.target.value || null)}
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

          {selected && steps.length === 0 ? (
            <p className="text-xs text-low">{t('cardPipeline.noSteps')}</p>
          ) : selected ? (
            <div className="flex flex-col gap-half">
              {steps.map((step) => (
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
              {dirty && (
                <button
                  type="button"
                  onClick={resetToCheckboxes}
                  disabled={disabled}
                  className="text-xs text-brand hover:underline disabled:opacity-50"
                >
                  {t('cardPipeline.resetToCheckboxes')}
                </button>
              )}
            </div>
            <textarea
              value={text}
              disabled={disabled}
              rows={6}
              onChange={(e) => {
                setText(e.target.value);
                setDirty(true);
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
