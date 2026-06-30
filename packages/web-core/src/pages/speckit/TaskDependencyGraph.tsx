import { CaretRightIcon } from '@phosphor-icons/react';
import { Fragment } from 'react';
import type { SpecKitTask, SpecKitTaskLayer } from 'shared/types';

interface TaskDependencyGraphProps {
  tasks: SpecKitTask[];
  layers: SpecKitTaskLayer[];
}

/**
 * Layered DAG view: each column is a dependency layer that runs after the one
 * to its left. A column with more than one chip is parallel-safe (`[P]`) — those
 * tasks can run concurrently. This visualizes parallelism; execution still
 * happens in the single feature worktree.
 */
export function TaskDependencyGraph({
  tasks,
  layers,
}: TaskDependencyGraphProps) {
  const byId = new Map<string, SpecKitTask>(tasks.map((t) => [t.id, t]));

  if (layers.length === 0) {
    return (
      <p className="text-sm text-low">No tasks to graph yet.</p>
    );
  }

  return (
    <div className="flex items-stretch gap-half overflow-x-auto p-half">
      {layers.map((layer, i) => (
        <Fragment key={i}>
          <div className="flex min-w-40 flex-col gap-half">
            <div className="text-center text-xs text-low">
              {layer.parallel ? `Parallel ×${layer.task_ids.length}` : 'Step'}
            </div>
            {layer.task_ids.map((id) => {
              const task = byId.get(id);
              const done = task?.done ?? false;
              return (
                <div
                  key={id}
                  className={`rounded-sm border px-half py-half text-xs ${
                    done
                      ? 'border-success/40 bg-success/10 text-low line-through'
                      : layer.parallel
                        ? 'border-brand/40 bg-brand/10 text-high'
                        : 'bg-panel/60 text-high'
                  }`}
                  title={task?.description ?? id}
                >
                  <span className="font-mono">{id}</span>
                  <span className="ml-half line-clamp-2">
                    {task?.description ?? ''}
                  </span>
                </div>
              );
            })}
          </div>
          {i < layers.length - 1 && (
            <div className="flex items-center text-low">
              <CaretRightIcon className="size-icon-sm" weight="bold" />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
