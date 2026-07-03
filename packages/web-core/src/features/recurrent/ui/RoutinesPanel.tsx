import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  SpinnerIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import type { Routine, RecurrentTomlError } from 'shared/types';
import { ApiError, recurrentApi } from '@/shared/lib/api';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { PrimaryButton } from '@vibe/ui/components/PrimaryButton';
import { IconButton } from '@vibe/ui/components/IconButton';
import { Switch } from '@vibe/ui/components/Switch';
import { ConfirmDialog } from '@vibe/ui/components/ConfirmDialog';
import {
  SettingsCard,
  SettingsField,
  SettingsInput,
  SettingsTextarea,
} from '@/shared/dialogs/settings/settings/SettingsComponents';

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

// Mirrors the server's `is_valid_slug`: a non-empty run of ASCII
// alphanumerics, `-`, or `_` (crates/services/src/services/recurrent/mod.rs).
const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function starterRoutineToml(name: string): string {
  return `name = "${tomlEscape(name)}"
enabled = false
prompt = """
Describe what this routine should do.
"""
executor_profile = "CLAUDE_CODE"
cron = "0 9 * * *"
# every = "30m"   # use instead of cron for an interval schedule
`;
}

export function RoutinesPanel({
  onDirtyChange,
  onOpenRun,
  management,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onOpenRun?: () => void;
  management?: boolean;
}) {
  const { t } = useTranslation(['settings', 'common']);
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

  // Create-routine inline form state (management-only).
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugEditedManually, setSlugEditedManually] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
    onDirtyChange?.(hasUnsavedChanges);
    return () => onDirtyChange?.(false);
  }, [hasUnsavedChanges, onDirtyChange]);

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
      onOpenRun?.();
    },
    [appNavigation, onOpenRun]
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

  const handleReload = useCallback(() => {
    setError(null);
    setSuccess(null);
    void reload();
  }, [reload]);

  const handleNameChange = useCallback(
    (value: string) => {
      setNewName(value);
      if (!slugEditedManually) {
        setNewSlug(slugify(value));
      }
    },
    [slugEditedManually]
  );

  const handleSlugChange = useCallback((value: string) => {
    setSlugEditedManually(true);
    setNewSlug(value);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setShowCreateForm(false);
    setNewName('');
    setNewSlug('');
    setSlugEditedManually(false);
    setCreateError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmedSlug = newSlug.trim();
    if (!trimmedSlug || !SLUG_PATTERN.test(trimmedSlug)) {
      setCreateError(t('settings.recurrent.create.invalidSlug'));
      return;
    }
    if (routines?.some((routine) => routine.id === trimmedSlug)) {
      setCreateError(t('settings.recurrent.create.duplicateSlug'));
      return;
    }
    setCreateError(null);
    setBusyId('__create__');
    try {
      const name = newName.trim() || trimmedSlug;
      await recurrentApi.saveRaw(trimmedSlug, starterRoutineToml(name));
      setShowCreateForm(false);
      setNewName('');
      setNewSlug('');
      setSlugEditedManually(false);
      await reload();
      await toggleExpand(trimmedSlug);
    } catch (err) {
      const data =
        err instanceof ApiError
          ? (err.error_data as RecurrentTomlError | undefined)
          : undefined;
      setCreateError(
        data?.message || errorMessage(err, t('settings.recurrent.saveError'))
      );
    } finally {
      setBusyId(null);
    }
  }, [newName, newSlug, routines, reload, toggleExpand, t]);

  const handleDelete = useCallback(
    async (id: string, name: string) => {
      const result = await ConfirmDialog.show({
        title: t('settings.recurrent.delete.confirmTitle'),
        message: t('settings.recurrent.delete.confirmMessage', { name }),
        confirmText: t('settings.recurrent.delete.confirmConfirm'),
        cancelText: t('settings.recurrent.delete.confirmCancel'),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;

      setBusyId(id);
      setError(null);
      try {
        await recurrentApi.remove(id);
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
      } catch (err) {
        setError(errorMessage(err, t('settings.recurrent.saveError')));
      } finally {
        setBusyId(null);
      }
    },
    [expandedId, reload, t]
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
        headerAction={
          management && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={ArrowClockwiseIcon}
                aria-label={t('settings.recurrent.reload')}
                title={t('settings.recurrent.reload')}
                onClick={handleReload}
              />
              <PrimaryButton
                variant="tertiary"
                value={t('settings.recurrent.create.button')}
                onClick={() => setShowCreateForm((prev) => !prev)}
              />
            </div>
          )
        }
      >
        <div className="space-y-3">
          {management && showCreateForm && (
            <div className="rounded-sm border border-border p-3 space-y-3 bg-secondary/30">
              <SettingsField label={t('settings.recurrent.create.nameLabel')}>
                <SettingsInput
                  value={newName}
                  onChange={handleNameChange}
                  placeholder={t('settings.recurrent.create.namePlaceholder')}
                />
              </SettingsField>
              <SettingsField
                label={t('settings.recurrent.create.slugLabel')}
                description={
                  createError
                    ? undefined
                    : t('settings.recurrent.create.slugHelp')
                }
                error={createError}
              >
                <SettingsInput
                  value={newSlug}
                  onChange={handleSlugChange}
                  error={!!createError}
                />
              </SettingsField>
              <div className="flex items-center gap-2">
                <PrimaryButton
                  value={t('settings.recurrent.create.submit')}
                  disabled={busyId === '__create__'}
                  onClick={handleCreate}
                />
                <PrimaryButton
                  variant="tertiary"
                  value={t('settings.recurrent.create.cancel')}
                  disabled={busyId === '__create__'}
                  onClick={handleCancelCreate}
                />
              </div>
            </div>
          )}

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

                    {management && (
                      <IconButton
                        icon={TrashIcon}
                        aria-label={t('settings.recurrent.delete.button')}
                        title={t('settings.recurrent.delete.button')}
                        disabled={busyId === routine.id}
                        onClick={() => handleDelete(routine.id, routine.name)}
                        className="hover:text-error hover:bg-error/10"
                      />
                    )}
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
