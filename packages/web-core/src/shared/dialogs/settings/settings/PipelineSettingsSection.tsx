import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretDownIcon,
  CaretRightIcon,
  SpinnerIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { PipelineFileStatus, PipelineValidation } from 'shared/types';
import { pipelinesApi } from '@/shared/lib/api';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { IconButton } from '@vibe/ui/components/IconButton';
import { SettingsCard, SettingsTextarea } from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

const BUNDLED_IDS = new Set(['basic', 'wikillm', 'speckit']);
const VALIDATE_DEBOUNCE_MS = 400;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function PipelineSettingsSection() {
  const { t } = useTranslation(['settings', 'common']);
  const { setDirty: setContextDirty } = useSettingsDirty();

  const [statuses, setStatuses] = useState<PipelineFileStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Loaded raw TOML and the operator's in-progress edits, keyed by pipeline id.
  const [rawById, setRawById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  // Draft validation results, keyed by pipeline id.
  const [validationById, setValidationById] = useState<
    Record<string, PipelineValidation>
  >({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Mirrors draftById so the async validate() response handler can detect
  // whether the draft moved on since the request was fired.
  const draftRef = useRef(draftById);
  useEffect(() => {
    draftRef.current = draftById;
  }, [draftById]);

  const reload = useCallback(async () => {
    try {
      const list = await pipelinesApi.status();
      setStatuses(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, t('settings.pipeline.loadError')));
      setStatuses([]);
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

  // Debounced draft validation for the currently expanded file.
  useEffect(() => {
    if (!expandedId) return;
    const id = expandedId;
    const content = draftById[id];
    if (content === undefined) return;

    const timer = setTimeout(() => {
      void pipelinesApi
        .validate(id, content)
        .then((result) => {
          // Ignore stale responses: only apply if the draft hasn't changed
          // again since this request was fired.
          if (draftRef.current[id] !== content) return;
          setValidationById((prev) => ({ ...prev, [id]: result }));
        })
        .catch(() => {
          // Best-effort; leave any prior validation state as-is.
        });
    }, VALIDATE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [expandedId, draftById]);

  const handleSave = useCallback(
    async (id: string) => {
      const content = draftById[id];
      if (content === undefined) return;
      setBusyId(id);
      setError(null);
      try {
        // Hard-block save on parse failure; the server's write_raw is the
        // backstop, but we don't want to round-trip an obviously bad draft.
        const validation = await pipelinesApi.validate(id, content);
        setValidationById((prev) => ({ ...prev, [id]: validation }));
        if (!validation.valid) {
          return;
        }
        await pipelinesApi.saveRaw(id, content);
        setRawById((prev) => ({ ...prev, [id]: content }));
        setValidationById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
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
        setValidationById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
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
        setValidationById((prev) => {
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
      setValidationById({});
      setExpandedId(null);
      await reload();
      flash(t('settings.pipeline.saved'));
    } catch (err) {
      setError(errorMessage(err, t('settings.pipeline.saveError')));
    } finally {
      setBusyId(null);
    }
  }, [reload, flash, t]);

  if (statuses === null && loadError === null) {
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
          {statuses && statuses.length === 0 ? (
            <p className="text-sm text-low">{t('settings.pipeline.empty')}</p>
          ) : (
            statuses?.map((s) => {
              const isOpen = expandedId === s.id;
              const draft = draftById[s.id] ?? '';
              const isDirty =
                draftById[s.id] !== undefined &&
                draftById[s.id] !== rawById[s.id];
              const draftValidation = validationById[s.id];
              const draftInvalid = draftValidation?.valid === false;
              return (
                <div
                  key={s.id}
                  className="rounded-sm border border-border p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(s.id)}
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
                      <span>{s.name}</span>
                      {!s.valid && (
                        <span
                          className="text-xs px-half rounded-sm font-medium bg-error/15 text-error"
                          title={s.error?.message}
                        >
                          {t('settings.pipeline.invalidBadge')}
                        </span>
                      )}
                      <span className="text-xs text-low">
                        {t('settings.pipeline.stageCount', {
                          n: s.stage_count ?? 0,
                        })}
                      </span>
                    </button>
                    <IconButton
                      icon={TrashIcon}
                      aria-label={t('settings.pipeline.remove')}
                      title={t('settings.pipeline.remove')}
                      disabled={busyId === s.id}
                      onClick={() => handleRemove(s.id)}
                      className="hover:text-error hover:bg-error/10"
                    />
                  </div>

                  {isOpen && (
                    <div className="space-y-2">
                      <SettingsTextarea
                        value={draft}
                        rows={14}
                        onChange={(value) =>
                          setDraftById((prev) => ({ ...prev, [s.id]: value }))
                        }
                        placeholder={t('settings.pipeline.rawPlaceholder')}
                      />
                      {draftInvalid && draftValidation?.error && (
                        <div className="text-sm text-error bg-error/10 border border-error/50 rounded-sm p-2">
                          <span className="font-medium">
                            {t('settings.pipeline.parseError')}:
                          </span>{' '}
                          {draftValidation.error.message}
                          {draftValidation.error.line != null && (
                            <span className="text-low">
                              {' '}
                              (
                              {t('settings.pipeline.errorAt', {
                                line: draftValidation.error.line,
                                column: draftValidation.error.column ?? 1,
                              })}
                              )
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <PrimaryButton
                          value={t('settings.pipeline.saveButton')}
                          disabled={!isDirty || busyId === s.id || draftInvalid}
                          onClick={() => handleSave(s.id)}
                        />
                        {BUNDLED_IDS.has(s.id) && (
                          <PrimaryButton
                            variant="tertiary"
                            value={t('settings.pipeline.reset')}
                            disabled={busyId === s.id}
                            onClick={() => handleResetOne(s.id)}
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
