import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Workspace } from 'shared/types';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { getInteractiveConfig } from '@/shared/lib/interactive';
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
  'rounded-[5px] text-brand text-[11px] font-bold tracking-tighter shrink-0 ' +
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
}: {
  glyph: string;
  title: string;
  onAction: () => Promise<void>;
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
  return (
    <button
      type="button"
      onClick={run}
      disabled={status === 'busy'}
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
 * session id, and an open-in-terminal `>_` icon. Renders nothing when there is
 * no live headed session.
 */
export function HeadedSessionIds({
  workspace,
}: {
  workspace?: Workspace | null;
}) {
  const { executionProcessesAll } = useExecutionProcessesContext();
  const [collapsed, setCollapsed] = useCollapsed(false);

  const headed = useMemo(() => {
    // The list is sorted created_at ascending; the latest running headed
    // coding-agent process owns the live tmux session.
    const process = [...executionProcessesAll]
      .reverse()
      .find(
        (p) =>
          p.run_reason === 'codingagent' &&
          p.status === 'running' &&
          getInteractiveConfig(p) !== null
      );
    if (!process) return null;
    const config = getInteractiveConfig(process);
    if (!config) return null;
    return {
      processId: process.id,
      tmuxSession: `vk-${process.id}`,
      sessionUuid: config.session_uuid,
    };
  }, [executionProcessesAll]);

  if (!headed) return null;

  const { processId, tmuxSession, sessionUuid } = headed;
  const folderName = workspaceFolderName(workspace);
  const folderPath = workspace?.container_ref ?? folderName;
  // Short, design-style ids (e.g. `vk-126fbec2…`, `93a3443b…`).
  const tmuxShort = `${tmuxSession.slice(0, 11)}…`;
  const claudeShort = `${sessionUuid.slice(0, 8)}…`;

  return (
    <div className="border-b bg-secondary px-3 pt-[11px] pb-3 font-mono">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-2 w-full px-0.5 py-px mb-2.5"
      >
        <span
          className={cn(
            'text-[10px] text-low transition-transform',
            collapsed && '-rotate-90'
          )}
        >
          ▾
        </span>
        <span className="text-[11px] tracking-[1.5px] uppercase font-bold text-normal">
          Sessions
        </span>
        <span className="text-[11px] text-brand">[2]</span>
        <span className="flex-1" />
      </button>

      {!collapsed && (
        <div className="flex flex-col">
          {/* Workspace folder row */}
          <div className="flex items-center gap-2 pl-2.5 pr-2 py-[7px] border rounded-md bg-panel">
            <span className="text-brand text-[13px]">▣</span>
            <span
              className="text-[11px] text-normal truncate flex-1"
              title={folderPath}
            >
              {folderName}
            </span>
            <CopyText
              text="⧉"
              copyValue={folderPath}
              title="Copy path"
              className="text-low text-xs px-1"
            />
            <span className="w-px h-4 bg-border" />
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
              <span className="w-[7px] h-[7px] rounded-full bg-success shadow-[0_0_5px_hsl(var(--_success)/0.6)] shrink-0" />
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
                title={`Open a terminal tab attached to ${tmuxSession}`}
                onAction={() => executionProcessesApi.openTerminal(processId)}
              />
            </div>

            {/* claude — resume in a new tmux session */}
            <div className="flex items-center gap-[9px] pl-2.5 pr-2 py-2 border border-border/60 rounded-md bg-panel">
              <span className="w-[7px] h-[7px] rounded-full bg-success shadow-[0_0_5px_hsl(var(--_success)/0.6)] shrink-0" />
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
