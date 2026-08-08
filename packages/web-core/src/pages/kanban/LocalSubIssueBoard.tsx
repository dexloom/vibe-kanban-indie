import { useMemo } from 'react';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeftIcon } from '@phosphor-icons/react';
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from '@hello-pangea/dnd';
import type { Issue } from 'shared/remote-types';
import { useProjectsContext } from '@/shared/providers/ProjectProvider';
import { ProjectProvider } from '@/shared/providers/remote/ProjectProvider';
import { useProjectContext } from '@/shared/hooks/useProjectContext';
import { useAppNavigation } from '@/shared/hooks/useAppNavigation';
import { usePageTitle } from '@/shared/hooks/usePageTitle';

/**
 * Route component for /projects/$projectId/issues/$issueId/sub-board. Mirrors
 * ProjectKanban's structure: resolve the project via the flat projects layer,
 * then mount the per-project ProjectProvider so the board can read issues +
 * statuses from context.
 */
export function LocalSubIssueBoard() {
  const params = useParams({ strict: false });
  const projectId = params.projectId as string | undefined;
  const parentIssueId = params.issueId as string | undefined;
  const { t } = useTranslation('common');
  const { projects, isLoading } = useProjectsContext();

  const project = projectId ? projects.find((p) => p.id === projectId) : null;

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-low">{t('states.loading')}</p>
      </div>
    );
  }

  if (!projectId || !parentIssueId || !project) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-low">{t('kanban.noProjectFound')}</p>
      </div>
    );
  }

  return (
    <ProjectProvider projectId={projectId}>
      <SubIssueBoard projectId={projectId} parentIssueId={parentIssueId} />
    </ProjectProvider>
  );
}

interface SubIssueBoardProps {
  projectId: string;
  parentIssueId: string;
}

/**
 * Full-page kanban of one parent issue's direct children, grouped by status.
 * Cards can be dragged between columns to change a child's status. The board
 * is self-contained (hello-pangea DnD scoped to this page) — it does not
 * participate in the main board's cross-surface drag system.
 */
function SubIssueBoard({ projectId, parentIssueId }: SubIssueBoardProps) {
  const { t } = useTranslation('common');
  const appNavigation = useAppNavigation();
  const { issues, statuses, getIssue, updateIssue } = useProjectContext();

  const parent = getIssue(parentIssueId);
  usePageTitle(parent?.title, t('kanban.subIssueBoardTitle'));

  const children = useMemo(
    () =>
      issues
        .filter((i) => i.parent_issue_id === parentIssueId)
        .sort(
          (a, b) =>
            (a.parent_issue_sort_order ?? 0) - (b.parent_issue_sort_order ?? 0)
        ),
    [issues, parentIssueId]
  );

  const visibleStatuses = useMemo(
    () =>
      [...statuses]
        .filter((s) => !s.hidden)
        .sort((a, b) => a.sort_order - b.sort_order),
    [statuses]
  );

  const childrenByStatus = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const s of visibleStatuses) map.set(s.id, []);
    for (const child of children) {
      const arr = map.get(child.status_id);
      if (arr) arr.push(child);
    }
    return map;
  }, [children, visibleStatuses]);

  const onDragEnd = (result: DropResult) => {
    const { source, destination, draggableId } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId) return;
    // Cross-column drop → change the child's status. Same-column reorder is
    // intentionally a no-op here (keeps the board focused on status moves).
    updateIssue(draggableId, { status_id: destination.droppableId });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-primary">
      {/* Header: back to the parent issue + parent title + child count. */}
      <div className="flex shrink-0 items-center gap-base border-b border-border px-double py-base">
        <button
          type="button"
          onClick={() =>
            appNavigation.goToProjectIssue(projectId, parentIssueId)
          }
          className="flex items-center gap-half rounded-sm p-half text-low hover:bg-secondary hover:text-normal transition-colors"
          aria-label={t('kanban.subIssueBoardBack')}
        >
          <ArrowLeftIcon className="size-icon-sm" weight="bold" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-half">
            <span className="text-sm text-low">
              {t('kanban.subIssueBoardTitle')}
            </span>
            {parent && (
              <span className="shrink-0 font-ibm-plex-mono text-sm text-low">
                {parent.simple_id}
              </span>
            )}
          </div>
          <p className="m-0 truncate text-base font-medium text-normal">
            {parent?.title ?? t('kanban.subIssueBoardTitle')}
          </p>
        </div>
        <span className="shrink-0 text-sm text-low">
          {t('kanban.subIssuesCount', { count: children.length })}
        </span>
      </div>

      {/* Board: one column per visible status. */}
      <div className="min-h-0 flex-1 overflow-x-auto px-double py-base">
        {children.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-low">{t('kanban.noSubIssues')}</p>
          </div>
        ) : (
          <DragDropContext onDragEnd={onDragEnd}>
            <div className="inline-grid min-h-full grid-flow-col auto-cols-[minmax(200px,360px)] items-stretch gap-base">
              {visibleStatuses.map((status) => {
                const column = childrenByStatus.get(status.id) ?? [];
                return (
                  <div
                    key={status.id}
                    className="flex min-h-40 flex-col rounded-md border border-border bg-secondary"
                  >
                    <div className="flex shrink-0 items-center gap-half border-b border-border p-base">
                      <span
                        aria-hidden="true"
                        className="size-2 rounded-full"
                        style={{ backgroundColor: `hsl(${status.color})` }}
                      />
                      <p className="m-0 flex-1 text-sm text-normal">
                        {status.name}
                      </p>
                      <span className="text-sm text-low">{column.length}</span>
                    </div>
                    <Droppable droppableId={status.id}>
                      {(provided) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          className="flex flex-1 flex-col gap-half overflow-y-auto p-half"
                        >
                          {column.map((child, index) => (
                            <Draggable
                              key={child.id}
                              draggableId={child.id}
                              index={index}
                            >
                              {(dragProvided) => (
                                <button
                                  type="button"
                                  ref={dragProvided.innerRef}
                                  {...dragProvided.draggableProps}
                                  {...dragProvided.dragHandleProps}
                                  onClick={() =>
                                    appNavigation.goToProjectIssue(
                                      projectId,
                                      child.id
                                    )
                                  }
                                  className="flex flex-col gap-half rounded-sm border border-border bg-surface p-base text-left cursor-grab active:cursor-grabbing hover:border-brand/40 transition-colors"
                                >
                                  <span className="shrink-0 font-ibm-plex-mono text-sm text-low">
                                    {child.simple_id}
                                  </span>
                                  <span className="text-base text-normal">
                                    {child.title}
                                  </span>
                                </button>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </div>
                );
              })}
            </div>
          </DragDropContext>
        )}
      </div>
    </div>
  );
}
