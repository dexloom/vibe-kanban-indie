import { useCallback, useEffect, useState } from 'react';
import type { Workspace } from 'shared/types';
import { useHeadedSession } from '@/shared/hooks/useHeadedSession';
import { executionProcessesApi } from '@/shared/lib/api';
import { writeClipboardViaBridge } from '@/shared/lib/clipboard';
import { PERSIST_KEYS } from '@/shared/stores/useUiPreferencesStore';
import { cn } from '@/shared/lib/utils';

// Faithful recreation of the "Navy HUD" Sessions block from the Kanban Terminal
// Redesign. Colors map to the app's theme tokens (brand = cyan on navy-hud,
// success = green) so the block adopts whatever theme is active; the cyan/navy
// look is what shows on the navy-hud theme the design targets.

const STORAGE_KEY = `vibe.ui.collapsible.${PERSIST_KEYS.sessionSection}`;
// The 26×24 cyan-bordered "terminal" button treatment shared by every action
// icon (open-in-terminal on each row + the folder's terminal/Finder buttons).
const ICON_BTN =
  'w-[26px] h-6 inline-flex items-center justify-center border border-brand/40 ' +
  'rounded-[5px] text-brand text-2xs font-bold tracking-tighter shrink-0 ' +
  'hover:border-brand hover:shadow-[0_0_6px_hsl(var(--_primary)/0.45)] ' +
  'transition-colors disabled:opacity-50';

type ActionStatus = 'idle' | 'busy' | 'error';

/** Persisted collapse state, matching CollapsibleSectionHeader's storage scheme. */
function useCollapsed(defaultCollapsed: boolean) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return defaultCollapsed;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      // CollapsibleSectionHeader stores `expanded`; invert for `collapsed`.
      if (stored != null) return stored !== 'true';
    } catch {
      /* ignore */
    }
    return defaultCollapsed;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(!collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  return [collapsed, setCollapsed] as const;
}

/** A 26×24 icon button (glyph) that runs an async action with subtle feedback. */
function IconButton({
  glyph,
  title,
  onAction,
  disabled,
}: {
  glyph: string;
  title: string;
  onAction: () => Promise<void>;
  disabled?: boolean;
}) {
  const [status, setStatus] = useState<ActionStatus>('idle');
  const run = useCallback(async () => {
    setStatus((prev) => (prev === 'busy' ? prev : 'busy'));
    try {
      await onAction();
      setStatus('idle');
    } catch (err) {
      console.error(`Session pane: "${title}" failed`, err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2500);
    }
  }, [onAction, title]);
  const isDisabled = disabled || status === 'busy';
  return (
    <button
      type="button"
      onClick={run}
      disabled={isDisabled}
      title={title}
      aria-label={title}
      className={cn(
        ICON_BTN,
        status === 'error' &&
          'border-[hsl(var(--_destructive))] text-[hsl(var(--_destructive))] hover:border-[hsl(var(--_destructive))]'
      )}
    >
      {glyph}
    </button>
  );
}

/** Click-to-copy text (session name / id / path); flashes to brand on success. */
function CopyText({
  text,
  copyValue,
  title,
  className,
}: {
  text: string;
  copyValue: string;
  title: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await writeClipboardViaBridge(copyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [copyValue]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={title}
      className={cn(
        'rounded-sm text-left hover:text-brand transition-colors',
        copied && 'text-brand',
        className
      )}
    >
      {text}
    </button>
  );
}

/** Final folder name shown on the workspace row (basename of the worktree path). */
function workspaceFolderName(workspace: Workspace | null | undefined): string {
  const ref = workspace?.container_ref;
  if (ref) {
    const segments = ref.split('/').filter(Boolean);
    if (segments.length) return segments[segments.length - 1];
  }
  return workspace?.name || workspace?.branch || 'workspace';
}

/**
 * The Sessions block for a headed (interactive tmux) coding-agent execution,
 * rendered at the top of the right sidebar. Recreates the Navy HUD design:
 * a collapsible `▾ SESSIONS [n]` block containing the workspace folder row
 * (folder glyph + name + copy + open-terminal `>_` + reveal-in-Finder `◫`) and
 * one row per session — `tmux` and `claude` — each with a status LED, the
 * session id, and an open-in-terminal `>_` icon. Renders for the latest headed
 * coding-agent session whether or not its tmux is still live; when it is not,
 * the tmux row's LED and attach action reflect the dead state while the
 * claude row's resume action stays available (it spawns a fresh tmux).
 * Renders nothing when there is no headed session at all.
 */
export function HeadedSessionIds({
  workspace,
}: {
  workspace?: Workspace | null;
}) {
  const [collapsed, setCollapsed] = useCollapsed(false);

  const headed = useHeadedSession();

  if (!headed) return null;

  const { processId, tmuxSession, sessionUuid, live } = headed;
  const folderName = workspaceFolderName(workspace);
  const folderPath = workspace?.container_ref ?? folderName;
  // Short, design-style ids (e.g. `vk-126fbec2…`, `93a3443b…`).
  const tmuxShort = `${tmuxSession.slice(0, 11)}…`;
  const claudeShort = `${sessionUuid.slice(0, 8)}…`;
  // tmux row: green + glow while the vk-<id> session is actually attachable;
  // a flat dead tone once tmux has exited.
  const tmuxLedClass = live
    ? 'bg-success shadow-[0_0_5px_hsl(var(--_success)/0.6)]'
    : 'bg-low';
  // claude row: green + glow when live, otherwise a neutral "resumable" brand
  // tone — resume is always available, it just spawns a fresh tmux session.
  const claudeLedClass = live
    ? 'bg-success shadow-[0_0_5px_hsl(var(--_success)/0.6)]'
    : 'bg-brand';

  return (
    <div className="border-b bg-secondary px-3 pt-[11px] pb-3 font-mono">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 w-full px-0.5 py-px mb-2.5"
      >
        <span
          className={cn(
            'text-2xs text-low transition-transform',
            collapsed && '-rotate-90'
          )}
        >
          ▾
        </span>
        <span className="text-2xs tracking-[1.5px] uppercase font-bold text-normal">
          Sessions
        </span>
        <span className="text-2xs text-brand">[2]</span>
        <span className="flex-1" />
      </button>

      {!collapsed && (
        <div className="flex flex-col">
          {/* Workspace folder row */}
          <div className="flex items-center gap-2 pl-2.5 pr-2 py-[7px] border rounded-md bg-panel">
            <span className="text-brand text-sm shrink-0">▣</span>
            <CopyText
              text="cd"
              copyValue={`cd ${folderPath}`}
              title={`Copy: cd ${folderPath}`}
              className="text-2xs text-normal shrink-0"
            />
            <CopyText
              text={folderName}
              copyValue={folderPath}
              title={folderPath}
              className="text-2xs text-low truncate flex-1 min-w-0"
            />
            <IconButton
              glyph=">_"
              title="Open a terminal in the workspace folder"
              onAction={() =>
                executionProcessesApi.openWorkspaceTerminal(processId)
              }
            />
            <IconButton
              glyph="◫"
              title="Reveal the workspace folder in Finder"
              onAction={() => executionProcessesApi.revealWorkspace(processId)}
            />
          </div>

          {/* Sessions list */}
          <div className="flex flex-col gap-1.5 mt-2">
            {/* tmux — the live, attached session */}
            <div className="flex items-center gap-[9px] pl-2.5 pr-2 py-2 border border-brand/40 rounded-md bg-panel shadow-[0_0_6px_hsl(var(--_primary)/0.35)]">
              <span
                className={cn(
                  'w-[7px] h-[7px] rounded-full shrink-0',
                  tmuxLedClass
                )}
              />
              <CopyText
                text="tmux"
                copyValue={`tmux attach -t ${tmuxSession}`}
                title={`Copy attach command: tmux attach -t ${tmuxSession}`}
                className="text-xs text-normal font-semibold"
              />
              <CopyText
                text={tmuxShort}
                copyValue={tmuxSession}
                title={`Copy tmux session id ${tmuxSession}`}
                className="text-[10.5px] text-low"
              />
              <span className="flex-1" />
              <IconButton
                glyph=">_"
                title={
                  live
                    ? `Open a terminal tab attached to ${tmuxSession}`
                    : 'Session ended — reattach unavailable'
                }
                disabled={!live}
                onAction={() => executionProcessesApi.openTerminal(processId)}
              />
            </div>

            {/* claude — resume in a new tmux session */}
            <div className="flex items-center gap-[9px] pl-2.5 pr-2 py-2 border border-border/60 rounded-md bg-panel">
              <span
                className={cn(
                  'w-[7px] h-[7px] rounded-full shrink-0',
                  claudeLedClass
                )}
              />
              <CopyText
                text="claude"
                copyValue={`claude --resume ${sessionUuid}`}
                title={`Copy resume command: claude --resume ${sessionUuid}`}
                className="text-xs text-normal font-semibold"
              />
              <CopyText
                text={claudeShort}
                copyValue={sessionUuid}
                title={`Copy Claude session id ${sessionUuid}`}
                className="text-[10.5px] text-low"
              />
              <span className="flex-1" />
              <IconButton
                glyph=">_"
                title={`Open a new tmux session running claude --resume ${sessionUuid}`}
                onAction={() =>
                  executionProcessesApi.openClaudeResume(processId)
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
