import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import type { Routine, RecurrentTomlError } from 'shared/types';
import { ApiError, recurrentApi } from '@/shared/lib/api';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { Switch } from '@vibe/ui/components/Switch';
import { SettingsCard, SettingsTextarea } from './SettingsComponents';
import { useSettingsDirty } from './SettingsDirtyContext';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-brand/10 text-brand';
    case 'completed':
      return 'bg-success/10 text-success';
    case 'failed':
    case 'killed':
      return 'bg-error/10 text-error';
    default:
      return 'bg-secondary text-low';
  }
}

export function RecurrentSettingsSection({
  onClose,
}: {
  onClose?: () => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const { setDirty: setContextDirty } = useSettingsDirty();
  const appNavigation = useAppNavigation();

  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Loaded raw TOML and the operator's in-progress edits, keyed by routine id.
  const [rawById, setRawById] = useState<Record<string, string>>({});
  const [draftById, setDraftById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await recurrentApi.list();
      setRoutines(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, t('settings.recurrent.loadError')));
      setRoutines([]);
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
    setContextDirty('recurrent', hasUnsavedChanges);
    return () => setContextDirty('recurrent', false);
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
          const raw = await recurrentApi.getRaw(id);
          setRawById((prev) => ({ ...prev, [id]: raw }));
          setDraftById((prev) => ({ ...prev, [id]: raw }));
        } catch (err) {
          setError(errorMessage(err, t('settings.recurrent.loadError')));
        }
      }
    },
    [expandedId, rawById, t]
  );

  const handleToggleEnabled = useCallback(
    async (id: string, next: boolean) => {
      setBusyId(id);
      setError(null);
      try {
        await recurrentApi.setEnabled(id, next);
        // The enable/disable endpoints return the file-parsed routine
        // (last_run: null) — reload() re-runs list() which enriches
        // last_run from the DB. Patching the row from the response would
        // wipe the displayed status/time/open-run link.
        await reload();
      } catch (err) {
        setError(errorMessage(err, t('settings.recurrent.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [reload, t]
  );

  const handleRunNow = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      try {
        const res = await recurrentApi.run(id);
        if (!res.spawned) {
          flash(t('settings.recurrent.runSkipped'));
        } else {
          flash(t('settings.recurrent.saved'));
        }
        // Reload on both outcomes so a run started elsewhere since the
        // list loaded is reflected too.
        await reload();
      } catch (err) {
        setError(errorMessage(err, t('settings.recurrent.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [reload, flash, t]
  );

  const handleOpenRun = useCallback(
    (workspaceId: string) => {
      appNavigation.goToWorkspace(workspaceId);
      onClose?.();
    },
    [appNavigation, onClose]
  );

  const handleSave = useCallback(
    async (id: string) => {
      const content = draftById[id];
      if (content === undefined) return;
      setBusyId(id);
      setError(null);
      try {
        await recurrentApi.saveRaw(id, content);
        setRawById((prev) => ({ ...prev, [id]: content }));
        await reload();
        flash(t('settings.recurrent.saved'));
      } catch (err) {
        // PUT /raw uses error_with_data, so err.message is generic; the
        // real TOML validation text is in error_data.message.
        const data =
          err instanceof ApiError
            ? (err.error_data as RecurrentTomlError | undefined)
            : undefined;
        setError(
          data?.message || errorMessage(err, t('settings.recurrent.saveError'))
        );
      } finally {
        setBusyId(null);
      }
    },
    [draftById, reload, flash, t]
  );

  if (routines === null && loadError === null) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <SpinnerIcon
          className="size-icon-lg animate-spin text-brand"
          weight="bold"
        />
        <span className="text-normal">{t('settings.recurrent.loading')}</span>
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
        title={t('settings.recurrent.list.title')}
        description={t('settings.recurrent.list.description')}
      >
        <div className="space-y-3">
          {routines && routines.length === 0 ? (
            <p className="text-sm text-low">{t('settings.recurrent.empty')}</p>
          ) : (
            routines?.map((routine) => {
              const isOpen = expandedId === routine.id;
              const draft = draftById[routine.id] ?? '';
              const isDirty =
                draftById[routine.id] !== undefined &&
                draftById[routine.id] !== rawById[routine.id];
              const scheduleLabel =
                routine.schedule.kind === 'cron'
                  ? t('settings.recurrent.schedule.cron', {
                      expr: routine.schedule.expr,
                    })
                  : t('settings.recurrent.schedule.every', {
                      expr: routine.schedule.expr,
                    });
              const lastRun = routine.last_run;

              return (
                <div
                  key={routine.id}
                  className="rounded-sm border border-border p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(routine.id)}
                      className="flex items-center gap-half text-sm font-medium text-high flex-1 text-left min-w-0"
                    >
                      {isOpen ? (
                        <CaretDownIcon className="size-icon-sm" weight="bold" />
                      ) : (
                        <CaretRightIcon
                          className="size-icon-sm"
                          weight="bold"
                        />
                      )}
                      <span className="truncate">{routine.name}</span>
                      <span className="text-xs text-low shrink-0">
                        {scheduleLabel}
                      </span>
                    </button>

                    {lastRun ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`text-xs rounded-full px-2 py-0.5 ${statusBadgeClass(
                            lastRun.status
                          )}`}
                        >
                          {t(`settings.recurrent.status.${lastRun.status}`, {
                            defaultValue: lastRun.status,
                          })}
                        </span>
                        <span className="text-xs text-low">
                          {new Date(lastRun.at).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleOpenRun(lastRun.workspace_id)}
                          className="flex items-center gap-half text-xs text-brand hover:underline"
                          title={t('settings.recurrent.openRun')}
                        >
                          <ArrowSquareOutIcon
                            className="size-icon-xs"
                            weight="bold"
                          />
                          {t('settings.recurrent.openRun')}
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-low shrink-0">
                        {t('settings.recurrent.neverRun')}
                      </span>
                    )}

                    <PrimaryButton
                      variant="tertiary"
                      value={t('settings.recurrent.runNow')}
                      disabled={busyId === routine.id}
                      onClick={() => handleRunNow(routine.id)}
                    />

                    <Switch
                      checked={routine.enabled}
                      disabled={busyId === routine.id}
                      onCheckedChange={(checked) =>
                        handleToggleEnabled(routine.id, checked)
                      }
                      title={t('settings.recurrent.enabledLabel')}
                    />
                  </div>

                  {isOpen && (
                    <div className="space-y-2">
                      <SettingsTextarea
                        value={draft}
                        rows={14}
                        monospace
                        onChange={(value) =>
                          setDraftById((prev) => ({
                            ...prev,
                            [routine.id]: value,
                          }))
                        }
                        placeholder={t('settings.recurrent.rawPlaceholder')}
                      />
                      <div className="flex items-center gap-2">
                        <PrimaryButton
                          value={t('settings.recurrent.saveButton')}
                          disabled={!isDirty || busyId === routine.id}
                          onClick={() => handleSave(routine.id)}
                        />
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
