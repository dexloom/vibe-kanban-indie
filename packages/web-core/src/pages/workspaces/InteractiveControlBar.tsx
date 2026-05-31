import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionProcess, InteractiveTmuxConfig } from 'shared/types';
import { Button } from '@vibe/ui/components/Button';
import { Input } from '@vibe/ui/components/Input';
import {
  TerminalIcon,
  CopyIcon,
  CheckIcon,
  PaperPlaneRightIcon,
} from '@phosphor-icons/react';
import { executionProcessesApi } from '@/shared/lib/api';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';
import { cn } from '@/shared/lib/utils';

/**
 * Interactive (detached tmux) config for a process, if it is a headed
 * coding-agent execution. Narrows the generated `ExecutorActionType` union
 * before reading `interactive` (Script/Review requests have no such field).
 */
export function getInteractiveConfig(
  process: ExecutionProcess
): InteractiveTmuxConfig | null {
  const typ = process.executor_action.typ;
  if (
    typ.type === 'CodingAgentInitialRequest' ||
    typ.type === 'CodingAgentFollowUpRequest'
  ) {
    return typ.interactive ?? null;
  }
  return null;
}

interface InteractiveControlBarProps {
  process: ExecutionProcess;
  config: InteractiveTmuxConfig;
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await writeClipboardViaBridge(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      className="text-low hover:text-normal transition-colors shrink-0"
    >
      {copied ? (
        <CheckIcon className="size-icon-sm" weight="bold" />
      ) : (
        <CopyIcon className="size-icon-sm" weight="regular" />
      )}
    </button>
  );
}

export function InteractiveControlBar({
  process,
  config,
}: InteractiveControlBarProps) {
  const { t } = useTranslation('common');
  const tmuxSession = `vk-${process.id}`;
  const attachCommand = `tmux attach -t ${tmuxSession}`;
  const running = process.status === 'running';

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenTerminal = useCallback(async () => {
    setError(null);
    setOpening(true);
    try {
      await executionProcessesApi.openTerminal(process.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [process.id]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);
    try {
      await executionProcessesApi.sendInput(process.id, text);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [input, sending, process.id]);

  return (
    <div className="flex flex-col gap-half px-base py-half border-b border-border bg-tertiary shrink-0">
      {/* Session identifiers (feature: id visible in frontend) */}
      <div className="flex items-center gap-2 font-mono text-xs text-low min-w-0">
        <span className="text-normal shrink-0">{tmuxSession}</span>
        <CopyButton value={tmuxSession} title={t('actions.copy')} />
        <span
          className="truncate"
          title={`claude session ${config.session_uuid}`}
        >
          claude: {config.session_uuid}
        </span>
        <CopyButton value={config.session_uuid} title={t('actions.copy')} />
        <span className="text-low/60 shrink-0">·</span>
        <span className="truncate" title={attachCommand}>
          {attachCommand}
        </span>
        <CopyButton value={attachCommand} title={t('actions.copy')} />
      </div>

      {/* Actions: open terminal + send input */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={handleOpenTerminal}
          disabled={!running || opening}
          className="shrink-0 gap-half"
        >
          <TerminalIcon className="size-icon-sm" weight="regular" />
          {t('processes.openInTerminal')}
        </Button>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('processes.sendInputPlaceholder')}
          disabled={!running || sending}
          onCommandEnter={() => void handleSend()}
          className="flex-1 h-8 rounded-sm border-border bg-secondary"
        />
        <Button
          variant="secondary"
          size="xs"
          onClick={handleSend}
          disabled={!running || sending || input.trim().length === 0}
          className="shrink-0 gap-half"
        >
          <PaperPlaneRightIcon className="size-icon-sm" weight="regular" />
          {t('processes.send')}
        </Button>
      </div>

      {error && (
        <div className={cn('text-xs text-destructive break-words')}>
          {error}
        </div>
      )}
    </div>
  );
}
