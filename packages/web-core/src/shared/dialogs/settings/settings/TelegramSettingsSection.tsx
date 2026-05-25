import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircleIcon, XCircleIcon } from '@phosphor-icons/react';
import type { TelegramStatus } from 'shared/types';
import { telegramApi } from '@/shared/lib/api';
import { Button } from '@vibe/ui/components/Button';
import { SettingsCard } from './SettingsComponents';

const EXAMPLE_TOML = `enabled = true
bot_token = "123456:ABC..."        # optional; falls back to env / ~/.claude/channels/telegram/.env
chat_id = "-1001234567890"
general_thread_id = "1"            # optional
per_worktree_topics = true         # spawn a forum topic per Claude Code worktree`;

type TestState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'done'; ok: boolean; error?: string | null };

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-low">{label}</span>
      <span className="font-medium text-normal">{children}</span>
    </div>
  );
}

function Bool({
  value,
  onLabel,
  offLabel,
}: {
  value: boolean;
  onLabel: string;
  offLabel: string;
}) {
  return (
    <span
      className={
        value
          ? 'inline-flex items-center gap-1 text-success'
          : 'inline-flex items-center gap-1 text-low'
      }
    >
      {value ? (
        <CheckCircleIcon className="size-icon-xs" weight="fill" />
      ) : (
        <XCircleIcon className="size-icon-xs" weight="fill" />
      )}
      {value ? onLabel : offLabel}
    </span>
  );
}

export function TelegramSettingsSection() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle' });

  const refresh = async () => {
    try {
      setStatus(await telegramApi.getStatus());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleTest = async () => {
    setTest({ status: 'sending' });
    try {
      const result = await telegramApi.sendTest();
      setTest({ status: 'done', ok: result.ok, error: result.error });
    } catch (e) {
      setTest({
        status: 'done',
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    refresh();
  };

  if (loadError) {
    return (
      <div className="bg-error/10 border border-error/50 rounded-sm p-4 text-error">
        {t('settings.telegram.status.loadError')}
      </div>
    );
  }

  return (
    <>
      <SettingsCard
        title={t('settings.telegram.title')}
        description={t('settings.telegram.description')}
      >
        {status && (
          <div className="divide-y divide-border/50">
            <StatusRow label={t('settings.telegram.status.title')}>
              <Bool
                value={status.enabled}
                onLabel={t('settings.telegram.status.enabled')}
                offLabel={t('settings.telegram.status.disabled')}
              />
            </StatusRow>
            <StatusRow label={t('settings.telegram.status.configured')}>
              <Bool
                value={status.configured}
                onLabel={t('settings.telegram.status.configured')}
                offLabel={t('settings.telegram.status.notConfigured')}
              />
            </StatusRow>
            {status.chat_id_masked && (
              <StatusRow label={t('settings.telegram.status.chatId')}>
                <span className="font-mono text-xs">
                  {status.chat_id_masked}
                </span>
              </StatusRow>
            )}
            {status.token_source && (
              <StatusRow label={t('settings.telegram.status.tokenSource')}>
                <span className="font-mono text-xs">{status.token_source}</span>
              </StatusRow>
            )}
            <StatusRow label={t('settings.telegram.status.perWorktreeTopics')}>
              <Bool
                value={status.per_worktree_topics}
                onLabel={t('settings.telegram.status.on')}
                offLabel={t('settings.telegram.status.off')}
              />
            </StatusRow>
            <StatusRow label="vibe-telegram-bridge">
              <span className="text-right">
                <Bool
                  value={status.bridge_connected}
                  onLabel={t('settings.telegram.status.bridgeConnected')}
                  offLabel={t('settings.telegram.status.bridgeDisconnected')}
                />
                {status.bridge_last_seen && (
                  <span className="block text-xs text-low">
                    {t('settings.telegram.status.lastSeen', {
                      time: new Date(status.bridge_last_seen).toLocaleString(),
                    })}
                  </span>
                )}
              </span>
            </StatusRow>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            onClick={handleTest}
            disabled={test.status === 'sending' || !status?.configured}
          >
            {test.status === 'sending'
              ? t('settings.telegram.test.sending')
              : t('settings.telegram.test.button')}
          </Button>
          {test.status === 'done' &&
            (test.ok ? (
              <span className="inline-flex items-center gap-1 text-sm text-success">
                <CheckCircleIcon className="size-icon-xs" weight="fill" />
                {t('settings.telegram.test.success')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm text-error">
                <XCircleIcon className="size-icon-xs" weight="fill" />
                {t('settings.telegram.test.failure', {
                  error: test.error ?? '',
                })}
              </span>
            ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title={t('settings.telegram.config.title')}
        description={t('settings.telegram.config.description')}
      >
        {status && (
          <p className="font-mono text-xs text-normal break-all">
            {status.config_path}
          </p>
        )}
        <div className="space-y-1">
          <label className="text-sm font-medium text-normal">
            {t('settings.telegram.config.example')}
          </label>
          <pre className="overflow-x-auto rounded-sm border border-border/50 bg-secondary/30 p-3 text-xs text-normal">
            {EXAMPLE_TOML}
          </pre>
        </div>
      </SettingsCard>
    </>
  );
}
