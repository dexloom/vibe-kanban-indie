import { useState } from 'react';
import {
  ArrowClockwiseIcon,
  CircleNotchIcon,
  PlayIcon,
} from '@phosphor-icons/react';
import type { SpecKitStage, SpecKitTask, SpecKitTasks } from 'shared/types';
import { specKitApi, ApiError } from '@/shared/lib/api';
import { TaskDependencyGraph } from './TaskDependencyGraph';

interface TasksStageProps {
  issueId: string;
  tasks: SpecKitTasks | null;
  running: boolean;
  liveHref: string | null;
  onRun: (stage: SpecKitStage, input: string | null) => void;
  onRefresh: () => void;
  onTasksChanged: (tasks: SpecKitTasks) => void;
}

/** Group tasks by their phase heading, preserving order. */
function groupByPhase(tasks: SpecKitTask[]): [string, SpecKitTask[]][] {
  const groups: [string, SpecKitTask[]][] = [];
  for (const task of tasks) {
    const phase = task.phase ?? 'Tasks';
    const last = groups[groups.length - 1];
    if (last && last[0] === phase) last[1].push(task);
    else groups.push([phase, [task]]);
  }
  return groups;
}

export function TasksStage({
  issueId,
  tasks,
  running,
  liveHref,
  onRun,
  onRefresh,
  onTasksChanged,
}: TasksStageProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const toggle = async (task: SpecKitTask) => {
    setPending(task.id);
    setError(null);
    try {
      const updated = await specKitApi.toggleTask(issueId, {
        task_id: task.id,
        done: !task.done,
      });
      onTasksChanged(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to update task.');
    } finally {
      setPending(null);
    }
  };

  const hasTasks = !!tasks && tasks.total > 0;

  return (
    <div className="flex h-full flex-col gap-base overflow-y-auto p-double">
      <header className="space-y-half">
        <h2 className="text-lg font-semibold text-high">Tasks</h2>
        <p className="text-sm text-low">
          Dependency-ordered task list. <span className="text-brand">[P]</span>{' '}
          tasks touch independent files and can run in parallel. Toggle a
          checkbox to mark a task done (writes back to tasks.md).
        </p>
      </header>

      <section className="space-y-half rounded-sm border p-base">
        <div className="flex items-center gap-base">
          <button
            type="button"
            disabled={running}
            onClick={() => onRun('tasks', null)}
            className="inline-flex items-center gap-half rounded-sm bg-brand px-base py-half text-sm font-medium text-white disabled:opacity-50"
          >
            {running ? (
              <CircleNotchIcon className="size-icon-sm animate-spin" />
            ) : (
              <PlayIcon className="size-icon-sm" weight="fill" />
            )}
            {running
              ? 'Running…'
              : hasTasks
                ? 'Regenerate tasks'
                : 'Generate tasks'}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-half rounded-sm border px-base py-half text-sm text-normal"
          >
            <ArrowClockwiseIcon className="size-icon-sm" />
            Refresh
          </button>
          {running && liveHref && (
            <a
              href={liveHref}
              className="text-sm text-brand underline"
              target="_blank"
              rel="noreferrer"
            >
              Open live agent session →
            </a>
          )}
        </div>
      </section>

      {error && <p className="text-sm text-error">{error}</p>}

      {!tasks || tasks.total === 0 ? (
        <p className="text-sm text-low">
          No tasks yet — generate them from the plan above.
        </p>
      ) : (
        <>
          <div className="text-sm text-normal">
            {tasks.completed} / {tasks.total} done
          </div>

          {/* Dependency / parallelism graph */}
          <section className="space-y-half rounded-sm border">
            <div className="border-b px-base py-half text-sm font-medium text-high">
              Execution graph
            </div>
            <TaskDependencyGraph tasks={tasks.tasks} layers={tasks.layers} />
          </section>

          {/* Checklist */}
          <section className="space-y-base">
            {groupByPhase(tasks.tasks).map(([phase, group]) => (
              <div key={phase} className="space-y-half">
                <h3 className="text-sm font-medium text-high">{phase}</h3>
                <ul className="space-y-px">
                  {group.map((task) => (
                    <li
                      key={task.id}
                      className="flex items-start gap-half rounded-sm px-half py-half hover:bg-panel/40"
                    >
                      <input
                        type="checkbox"
                        checked={task.done}
                        disabled={pending === task.id}
                        onChange={() => void toggle(task)}
                        className="mt-px"
                      />
                      <span className="font-mono text-xs text-low">
                        {task.id}
                      </span>
                      {task.parallelizable && (
                        <span className="rounded-sm bg-brand/15 px-half text-xs text-brand">
                          P
                        </span>
                      )}
                      <span
                        className={`text-sm ${
                          task.done ? 'text-low line-through' : 'text-high'
                        }`}
                      >
                        {task.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
