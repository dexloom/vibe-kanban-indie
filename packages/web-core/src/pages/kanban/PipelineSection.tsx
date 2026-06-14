import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';
import type { Config } from 'shared/types';
import {
  composePipelineBlock,
  effectiveSteps,
} from '@/shared/lib/pipeline/cardPipeline';

export interface PipelineSelection {
  /** Ticked step ids, in catalog order. */
  enabledIds: string[];
  /** Pinned execution agent (`BaseCodingAgent` key) or null for the default. */
  executor: string | null;
  /** The operator's free-text addition (may be empty). */
  customText: string;
  /** The composed `## Pipeline` markdown block (empty when nothing selected). */
  block: string;
}

interface PipelineSectionProps {
  /** Host config; provides the (custom or default) step catalog. */
  config: Config | null | undefined;
  /** Available executor profiles, keyed by `BaseCodingAgent`. */
  profiles: Record<string, unknown> | null;
  /** Disabled while the card is being submitted. */
  disabled?: boolean;
  /** Emits the current selection whenever it changes. */
  onChange: (selection: PipelineSelection) => void;
}

/**
 * Per-card "Pipeline" control for the New Issue dialog (create mode only).
 * Reads the configurable step catalog, lets the operator tick which stages
 * apply and edit the composed prompt block, and emits the result so the
 * container can append it to the card description (and mirror provenance into
 * `extension_metadata.pipeline`).
 */
export function PipelineSection({
  config,
  profiles,
  disabled,
  onChange,
}: PipelineSectionProps) {
  const { t } = useTranslation('common');
  const steps = useMemo(() => effectiveSteps(config), [config]);
  const agents = useMemo(
    () => (profiles ? Object.keys(profiles).sort() : []),
    [profiles]
  );

  const [expanded, setExpanded] = useState(false);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(
    () => new Set(steps.filter((s) => s.default_enabled).map((s) => s.id))
  );
  // Pinned execution agent (null = let the orchestrator pick its default).
  const [executor, setExecutor] = useState<string | null>(null);
  // The composed block, regenerated from the ticks until the operator edits it.
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);

  // Re-seed the ticks when the catalog identity changes (e.g. config loads or
  // the operator customises steps in Settings). Resets any manual edits.
  const stepsKey = useMemo(() => steps.map((s) => s.id).join(','), [steps]);
  useEffect(() => {
    setEnabledIds(
      new Set(steps.filter((s) => s.default_enabled).map((s) => s.id))
    );
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsKey]);

  // Keep the textarea in sync with the ticks/agent until the operator takes over.
  useEffect(() => {
    if (dirty) return;
    setText(composePipelineBlock(steps, enabledIds, '', executor));
  }, [steps, enabledIds, executor, dirty]);

  // Notify the parent of the effective selection. `block` is the operator's
  // edited text when dirty, else the freshly composed block.
  const emittedRef = useRef<string>('');
  useEffect(() => {
    const block = dirty
      ? text.trim()
      : composePipelineBlock(steps, enabledIds, '', executor);
    const signature = `${[...enabledIds].sort().join(',')}|${executor ?? ''}|${block}`;
    if (emittedRef.current === signature) return;
    emittedRef.current = signature;
    onChange({
      enabledIds: steps.filter((s) => enabledIds.has(s.id)).map((s) => s.id),
      executor,
      customText: dirty ? text : '',
      block,
    });
  }, [steps, enabledIds, executor, text, dirty, onChange]);

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
    setText(composePipelineBlock(steps, enabledIds, '', executor));
  }, [steps, enabledIds, executor]);

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

          {steps.length === 0 ? (
            <p className="text-xs text-low">{t('cardPipeline.noSteps')}</p>
          ) : (
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
          )}

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
