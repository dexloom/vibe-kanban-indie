import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import { PlusIcon, SpinnerIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';

export interface ProjectsGroupProject {
  id: string;
  name: string;
  color: string;
}

interface ProjectsGroupProps {
  projects: ProjectsGroupProject[];
  activeProjectId: string | null;
  isSignedIn: boolean;
  isLoading: boolean;
  isSavingProjectOrder?: boolean;
  onProjectClick: (projectId: string) => void;
  onCreateProject: () => void;
  onProjectsDragEnd: (result: DropResult) => void;
  className?: string;
}

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export function ProjectsGroup({
  projects,
  activeProjectId,
  isSignedIn,
  isLoading,
  isSavingProjectOrder,
  onProjectClick,
  onCreateProject,
  onProjectsDragEnd,
  className,
}: ProjectsGroupProps) {
  const { t } = useTranslation('common');

  return (
    <section
      aria-label={t('appBar.projects')}
      className={cn(
        'rounded-lg border border-border bg-primary/40 px-2 py-2',
        className
      )}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-low">
          {t('appBar.projects')}
        </span>
        {isSignedIn && (
          <button
            type="button"
            onClick={onCreateProject}
            aria-label="Create project"
            title="Create project"
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded-sm text-low',
              'hover:bg-tertiary hover:text-normal cursor-pointer transition-colors'
            )}
          >
            <PlusIcon className="size-icon-xs" weight="bold" />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-2">
          <SpinnerIcon className="size-icon-sm animate-spin text-muted" />
        </div>
      ) : (
        <DragDropContext onDragEnd={onProjectsDragEnd}>
          <Droppable
            droppableId="sidebar-projects"
            direction="vertical"
            isDropDisabled={isSavingProjectOrder}
          >
            {(dropProvided) => (
              <div
                ref={dropProvided.innerRef}
                {...dropProvided.droppableProps}
                className="flex flex-col gap-0.5"
              >
                {projects.map((project, index) => (
                  <Draggable
                    key={project.id}
                    draggableId={project.id}
                    index={index}
                    disableInteractiveElementBlocking
                    isDragDisabled={isSavingProjectOrder}
                  >
                    {(dragProvided, snapshot) => (
                      <div
                        ref={dragProvided.innerRef}
                        {...dragProvided.draggableProps}
                        {...dragProvided.dragHandleProps}
                        style={dragProvided.draggableProps.style}
                      >
                        <button
                          type="button"
                          onClick={() => onProjectClick(project.id)}
                          aria-label={project.name}
                          title={project.name}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5',
                            'text-left text-sm cursor-grab transition-colors',
                            snapshot.isDragging && 'shadow-lg',
                            project.id === activeProjectId
                              ? 'text-high'
                              : 'text-normal hover:bg-tertiary'
                          )}
                          style={
                            project.id === activeProjectId
                              ? {
                                  color: `hsl(${project.color})`,
                                  backgroundColor: `hsl(${project.color} / 0.2)`,
                                }
                              : undefined
                          }
                        >
                          <span
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium"
                            style={
                              project.id === activeProjectId
                                ? {
                                    color: `hsl(${project.color})`,
                                    backgroundColor: `hsl(${project.color} / 0.15)`,
                                  }
                                : {
                                    backgroundColor: `hsl(${project.color} / 0.2)`,
                                    color: `hsl(${project.color})`,
                                  }
                            }
                            aria-hidden="true"
                          >
                            {getProjectInitials(project.name)}
                          </span>
                          <span className="truncate">{project.name}</span>
                        </button>
                      </div>
                    )}
                  </Draggable>
                ))}
                {dropProvided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}
    </section>
  );
}
