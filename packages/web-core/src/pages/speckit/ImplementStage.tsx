import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CircleNotchIcon,
  PlayIcon,
} from '@phosphor-icons/react';
import type { SpecKitStage, SpecKitTasks } from 'shared/types';

interface ImplementStageProps {
  tasks: SpecKitTasks | null;
  running: boolean;
  /** Live agent-session URL — the existing workspace view streams the
   * transcript + diffs for the run. */
  liveHref: string | null;
  onRun: (stage: SpecKitStage, input: string | null) => void;
  onRefresh: () => void;
}

export function ImplementStage({
  tasks,
  running,
  liveHref,
  onRun,
  onRefresh,
}: ImplementStageProps) {
  const total = tasks?.total ?? 0;
  const completed = tasks?.completed ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="flex h-full flex-col gap-base overflow-y-auto p-double">
      <header className="space-y-half">
        <h2 className="text-lg font-semibold text-high">Implement</h2>
        <p className="text-sm text-low">
          Runs <span className="font-mono">/speckit.implement</span> in the
          feature worktree, executing the task list in dependency order. Tasks
          marked <span className="text-brand">[P]</span> within a layer are done
          together. Watch the transcript and diffs in the live session.
        </p>
      </header>

      <section className="space-y-base rounded-sm border p-base">
        <div className="flex items-center gap-base">
          <button
            type="button"
            disabled={running}
            onClick={() => onRun('implement', null)}
            className="inline-flex items-center gap-half rounded-sm bg-brand px-base py-half text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? (
              <CircleNotchIcon className="size-icon-sm animate-spin" />
            ) : (
              <PlayIcon className="size-icon-sm" weight="fill" />
            )}
            {running ? 'Implementing…' : 'Run implement'}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-half rounded-sm border px-base py-half text-sm text-normal"
          >
            <ArrowClockwiseIcon className="size-icon-sm" />
            Refresh progress
          </button>
          {liveHref && (
            <a
              href={liveHref}
              className="inline-flex items-center gap-half text-sm text-brand underline"
              target="_blank"
              rel="noreferrer"
            >
              <ArrowSquareOutIcon className="size-icon-sm" />
              Live session: transcript + diffs
            </a>
          )}
        </div>

        {/* Progress */}
        <div className="space-y-half">
          <div className="flex justify-between text-xs text-low">
            <span>Task progress</span>
            <span>
              {completed} / {total} ({pct}%)
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-panel">
            <div
              className="h-full bg-success transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </section>

      {total === 0 && (
        <p className="text-sm text-low">
          No tasks to implement yet — generate the task list in the Tasks stage
          first.
        </p>
      )}
    </div>
  );
}
