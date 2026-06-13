import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cloneDeep, isEqual } from 'lodash';
import { PlusIcon, SpinnerIcon, TrashIcon } from '@phosphor-icons/react';
import { DEFAULT_PIPELINE_STEPS, type PipelineStep } from 'shared/types';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { IconButton } from '@vibe/ui/components/IconButton';
import {
  SettingsCard,
  SettingsCheckbox,
  SettingsField,
  SettingsInput,
  SettingsSaveBar,
  SettingsTextarea,
} from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

/** Slug a label into a stable-ish id; collisions are de-duped by the caller. */
function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'step'
  );
}

export function PipelineSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const { setDirty: setContextDirty } = useSettingsDirty();
  const { config, loading, updateAndSaveConfig } = useUserSystem();

  const [draft, setDraft] = useState(() => (config ? cloneDeep(config) : null));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!config) return;
    if (!dirty) {
      setDraft(cloneDeep(config));
    }
  }, [config, dirty]);

  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !config) return false;
    return !isEqual(draft, config);
  }, [draft, config]);

  useEffect(() => {
    setContextDirty('pipeline', hasUnsavedChanges);
    return () => setContextDirty('pipeline', false);
  }, [hasUnsavedChanges, setContextDirty]);

  // Top-level replace (not deep-merge) so array edits/removals stick.
  const setSteps = useCallback(
    (steps: PipelineStep[] | null) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, pipeline_steps: steps };
        if (!isEqual(next, config)) setDirty(true);
        return next;
      });
    },
    [config]
  );

  const steps = draft?.pipeline_steps ?? null;
  const isCustom = steps != null;
  const displaySteps = steps ?? DEFAULT_PIPELINE_STEPS;

  const handleToggleCustom = useCallback(
    (checked: boolean) => {
      setSteps(checked ? cloneDeep(DEFAULT_PIPELINE_STEPS) : null);
    },
    [setSteps]
  );

  const handleReset = useCallback(() => {
    setSteps(cloneDeep(DEFAULT_PIPELINE_STEPS));
  }, [setSteps]);

  const updateStep = useCallback(
    (index: number, patch: Partial<PipelineStep>) => {
      if (!steps) return;
      const next = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
      setSteps(next);
    },
    [steps, setSteps]
  );

  const removeStep = useCallback(
    (index: number) => {
      if (!steps) return;
      setSteps(steps.filter((_, i) => i !== index));
    },
    [steps, setSteps]
  );

  const addStep = useCallback(() => {
    const existing = steps ?? [];
    const used = new Set(existing.map((s) => s.id));
    let n = existing.length + 1;
    let id = `step-${n}`;
    while (used.has(id)) {
      n += 1;
      id = `step-${n}`;
    }
    setSteps([
      ...existing,
      { id, label: '', prompt_fragment: '', default_enabled: false },
    ]);
  }, [steps, setSteps]);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      // Normalise ids so each step has a unique, slug-derived id before saving.
      let normalised = draft.pipeline_steps;
      if (normalised) {
        const used = new Set<string>();
        normalised = normalised.map((s) => {
          let base = s.id?.trim() || slugify(s.label);
          let id = base;
          let n = 2;
          while (used.has(id)) {
            id = `${base}-${n}`;
            n += 1;
          }
          used.add(id);
          return { ...s, id };
        });
      }
      await updateAndSaveConfig({ ...draft, pipeline_steps: normalised });
      setDirty(false);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(t('settings.pipeline.save.error'));
      console.error('Error saving pipeline config:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setDraft(cloneDeep(config));
    setDirty(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand"
          weight="bold"
        />
        <span className="text-normal">{t('settings.pipeline.loading')}</span>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="py-8">
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {t('settings.pipeline.loadError')}
        </div>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium">
          {t('settings.pipeline.save.success')}
        </div>
      )}

      <SettingsCard
        title={t('settings.pipeline.steps.title')}
        description={t('settings.pipeline.steps.description')}
        headerAction={
          isCustom ? (
            <PrimaryButton
              variant="tertiary"
              value={t('settings.pipeline.steps.reset')}
              onClick={handleReset}
            />
          ) : undefined
        }
      >
        <SettingsCheckbox
          id="customize-pipeline-steps"
          label={t('settings.pipeline.steps.customize.label')}
          description={t('settings.pipeline.steps.customize.helper')}
          checked={isCustom}
          onChange={handleToggleCustom}
        />

        <div className="space-y-4">
          {displaySteps.length === 0 ? (
            <p className="text-sm text-low">
              {t('settings.pipeline.steps.empty')}
            </p>
          ) : (
            displaySteps.map((step, index) => (
              <div
                key={index}
                className="space-y-2 rounded-sm border border-border p-3"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 space-y-2">
                    <SettingsField
                      label={t('settings.pipeline.steps.fields.label')}
                    >
                      <SettingsInput
                        value={step.label}
                        disabled={!isCustom}
                        onChange={(value) =>
                          updateStep(index, { label: value })
                        }
                        placeholder={t(
                          'settings.pipeline.steps.fields.labelPlaceholder'
                        )}
                      />
                    </SettingsField>
                  </div>
                  {isCustom && (
                    <IconButton
                      icon={TrashIcon}
                      aria-label={t('settings.pipeline.steps.actions.remove')}
                      title={t('settings.pipeline.steps.actions.remove')}
                      onClick={() => removeStep(index)}
                      className="mt-6 hover:text-error hover:bg-error/10"
                    />
                  )}
                </div>

                <SettingsField
                  label={t('settings.pipeline.steps.fields.prompt')}
                >
                  <SettingsTextarea
                    value={step.prompt_fragment}
                    disabled={!isCustom}
                    rows={3}
                    onChange={(value) =>
                      updateStep(index, { prompt_fragment: value })
                    }
                    placeholder={t(
                      'settings.pipeline.steps.fields.promptPlaceholder'
                    )}
                  />
                </SettingsField>

                <SettingsCheckbox
                  id={`pipeline-step-default-${index}`}
                  label={t('settings.pipeline.steps.fields.defaultEnabled')}
                  checked={step.default_enabled}
                  disabled={!isCustom}
                  onChange={(checked) =>
                    updateStep(index, { default_enabled: checked })
                  }
                />
              </div>
            ))
          )}

          {isCustom && (
            <PrimaryButton
              variant="tertiary"
              onClick={addStep}
              actionIcon={PlusIcon}
            >
              {t('settings.pipeline.steps.actions.add')}
            </PrimaryButton>
          )}
        </div>
      </SettingsCard>

      <SettingsSaveBar
        show={hasUnsavedChanges}
        saving={saving}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    </>
  );
}
