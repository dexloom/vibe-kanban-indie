import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CaretRightIcon,
  SpinnerIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { Pipeline } from 'shared/types';
import { pipelinesApi } from '@/shared/lib/api';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { IconButton } from '@vibe/ui/components/IconButton';
import { SettingsCard, SettingsTextarea } from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

const BUNDLED_IDS = new Set(['basic', 'wikillm', 'speckit']);

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function PipelineSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const { setDirty: setContextDirty } = useSettingsDirty();

  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Loaded raw TOML and the operator's in-progress edits, keyed by pipeline id.
  const [rawById, setRawById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await pipelinesApi.list();
      setPipelines(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, t('settings.pipeline.loadError')));
      setPipelines([]);
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const hasUnsavedChanges = useMemo(
    () =>
      Object.keys(draftById).some(
        (id) => draftById[id] !== undefined && draftById[id] !== rawById[id]
      ),
    [draftById, rawById]
  );

  useEffect(() => {
    setContextDirty('pipeline', hasUnsavedChanges);
    return () => setContextDirty('pipeline', false);
  }, [hasUnsavedChanges, setContextDirty]);

  const flash = useCallback((message: string) => {
    setSuccess(message);
    setError(null);
    setTimeout(() => setSuccess(null), 3000);
  }, []);

  const toggleExpand = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      if (rawById[id] === undefined) {
        try {
          const raw = await pipelinesApi.getRaw(id);
          setRawById((prev) => ({ ...prev, [id]: raw }));
          setDraftById((prev) => ({ ...prev, [id]: raw }));
        } catch (err) {
          setError(errorMessage(err, t('settings.pipeline.loadError')));
        }
      }
    },
    [expandedId, rawById, t]
  );

  const handleSave = useCallback(
    async (id: string) => {
      const content = draftById[id];
      if (content === undefined) return;
      setBusyId(id);
      setError(null);
      try {
        await pipelinesApi.saveRaw(id, content);
        setRawById((prev) => ({ ...prev, [id]: content }));
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        // Surfaces the server's parse/validation message.
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [draftById, reload, flash, t]
  );

  const handleResetOne = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await pipelinesApi.resetOne(id);
        const raw = await pipelinesApi.getRaw(id);
        setRawById((prev) => ({ ...prev, [id]: raw }));
        setDraftById((prev) => ({ ...prev, [id]: raw }));
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [reload, flash, t]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        await pipelinesApi.remove(id);
        setRawById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setDraftById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        if (expandedId === id) setExpandedId(null);
        await reload();
        flash(t('settings.pipeline.saved'));
      } catch (err) {
        setError(errorMessage(err, t('settings.pipeline.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [expandedId, reload, flash, t]
  );

  const handleResetAll = useCallback(async () => {
    setBusyId('__all__');
    setError(null);
    try {
      await pipelinesApi.resetDefaults();
      setRawById({});
      setDraftById({});
      setExpandedId(null);
      await reload();
      flash(t('settings.pipeline.saved'));
    } catch (err) {
      setError(errorMessage(err, t('settings.pipeline.saveError')));
    } finally {
      setBusyId(null);
    }
  }, [reload, flash, t]);

  if (pipelines === null && loadError === null) {
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

  return (
    <>
      {error && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error whitespace-pre-wrap">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-success/10 border border-success/50 rounded-sm p-4 text-success font-medium">
          {success}
        </div>
      )}
      {loadError && (
        <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
          {loadError}
        </div>
      )}

      <SettingsCard
        title={t('settings.pipeline.files.title')}
        description={t('settings.pipeline.files.description')}
        headerAction={
          <PrimaryButton
            variant="tertiary"
            value={t('settings.pipeline.resetAll')}
            disabled={busyId === '__all__'}
            onClick={handleResetAll}
          />
        }
      >
        <div className="space-y-3">
          {pipelines && pipelines.length === 0 ? (
            <p className="text-sm text-low">{t('settings.pipeline.empty')}</p>
          ) : (
            pipelines?.map((p) => {
              const isOpen = expandedId === p.id;
              const draft = draftById[p.id] ?? '';
              const isDirty =
                draftById[p.id] !== undefined &&
                draftById[p.id] !== rawById[p.id];
              return (
                <div
                  key={p.id}
                  className="rounded-sm border border-border p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(p.id)}
                      className="flex items-center gap-half text-sm font-medium text-high flex-1 text-left"
                    >
                      {isOpen ? (
                        <CaretDownIcon className="size-icon-sm" weight="bold" />
                      ) : (
                        <CaretRightIcon
                          className="size-icon-sm"
                          weight="bold"
                        />
                      )}
                      <span>{p.name}</span>
                      <span className="text-xs text-low">
                        {t('settings.pipeline.stageCount', {
                          n: p.stages.length,
                        })}
                      </span>
                    </button>
                    <IconButton
                      icon={TrashIcon}
                      aria-label={t('settings.pipeline.remove')}
                      title={t('settings.pipeline.remove')}
                      disabled={busyId === p.id}
                      onClick={() => handleRemove(p.id)}
                      className="hover:text-error hover:bg-error/10"
                    />
                  </div>

                  {isOpen && (
                    <div className="space-y-2">
                      <SettingsTextarea
                        value={draft}
                        rows={14}
                        onChange={(value) =>
                          setDraftById((prev) => ({ ...prev, [p.id]: value }))
                        }
                        placeholder={t('settings.pipeline.rawPlaceholder')}
                      />
                      <div className="flex items-center gap-2">
                        <PrimaryButton
                          value={t('settings.pipeline.saveButton')}
                          disabled={!isDirty || busyId === p.id}
                          onClick={() => handleSave(p.id)}
                        />
                        {BUNDLED_IDS.has(p.id) && (
                          <PrimaryButton
                            variant="tertiary"
                            value={t('settings.pipeline.reset')}
                            disabled={busyId === p.id}
                            onClick={() => handleResetOne(p.id)}
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </SettingsCard>
    </>
  );
}
