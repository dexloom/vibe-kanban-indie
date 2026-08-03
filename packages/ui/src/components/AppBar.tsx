import {
  DragDropContext,
  Draggable,
  Droppable,
  type DropResult,
} from '@hello-pangea/dnd';
import { Fragment, type ReactNode } from 'react';
import {
  LayoutIcon,
  ChatCircleIcon,
  ClockClockwiseIcon,
  LinkIcon,
  PlusIcon,
  SpinnerIcon,
  type Icon,
} from '@phosphor-icons/react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';

  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export type AppBarBadgeTone = 'success' | 'danger' | 'brand';

export interface AppBarBadge {
  tone: AppBarBadgeTone;
  count: number;
  label: string;
}

interface AppBarProps {
  projects: AppBarProject[];
  hosts?: AppBarHost[];
  onPairHostClick?: () => void;
  activeHostId?: string | null;
  onCreateProject: () => void;
  onCommonTasksClick?: () => void;
  onWorkspacesClick: () => void;
  onChatClick?: () => void;
  onHostClick?: (hostId: string, status: AppBarHostStatus) => void;
  showWorkspacesButton?: boolean;
  onProjectClick: (projectId: string) => void;
  onProjectsDragEnd: (result: DropResult) => void;
  isSavingProjectOrder?: boolean;
  isWorkspacesActive: boolean;
  isChatActive?: boolean;
  workspacesBadges?: AppBarBadge[];
  chatBadges?: AppBarBadge[];
  isCommonTasksActive?: boolean;
  activeProjectId: string | null;
  isSignedIn?: boolean;
  isLoadingProjects?: boolean;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  notificationBell?: ReactNode;
  userPopover?: ReactNode;
  appVersion?: string | null;
  updateVersion?: string | null;
  onUpdateClick?: () => void;
}

export interface AppBarProject {
  id: string;
  name: string;
  color: string;
}

export type AppBarHostStatus = 'online' | 'offline' | 'unpaired';

export interface AppBarHost {
  id: string;
  name: string;
  status: AppBarHostStatus;
}

function getHostStatusLabel(status: AppBarHostStatus): string {
  if (status === 'online') return 'Online';
  if (status === 'offline') return 'Offline';
  return 'Unpaired';
}

function getHostStatusIndicatorClass(status: AppBarHostStatus): string {
  if (status === 'online') return 'bg-success';
  if (status === 'offline') return 'bg-low';
  return 'bg-white border-warning';
}

function getBadgeToneClassName(tone: AppBarBadgeTone): string {
  switch (tone) {
    case 'success':
      return 'bg-success';
    case 'danger':
      return 'bg-error';
    case 'brand':
      return 'bg-brand';
  }
}

function AppBarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="w-full text-center text-xs font-medium leading-none tracking-wide text-low">
      {children}
    </p>
  );
}

// A nav group: its icons on top, the group label BELOW them, wrapped in a
// subtle rounded border so adjacent groups read as separate blocks.
function AppBarSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-1 rounded-lg border border-border bg-primary/40 px-1 py-2">
      {children}
      <AppBarSectionLabel>{label}</AppBarSectionLabel>
    </div>
  );
}

const appBarItemBaseClassName =
  'flex items-center justify-center w-10 h-10 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

type AppBarSection = {
  key: 'local' | 'remote' | 'projects' | 'export' | 'common-tasks';
  label: string;
  items: AppBarSectionItem[];
  dividerAfter?: boolean;
};

type AppBarSectionItem =
  | {
      key: string;
      kind: 'icon-button';
      label: string;
      icon: Icon;
      isActive?: boolean;
      onClick?: () => void;
      className?: string;
      wrapperClassName?: string;
      badges?: AppBarBadge[];
    }
  | {
      key: string;
      kind: 'host-button';
      host: AppBarHost;
      isActive: boolean;
      onClick?: () => void;
      wrapperClassName?: string;
    }
  | {
      key: string;
      kind: 'loading';
    }
  | {
      key: string;
      kind: 'project-list';
      projects: AppBarProject[];
      activeProjectId: string | null;
      isSavingProjectOrder?: boolean;
      onProjectClick: (projectId: string) => void;
      onProjectsDragEnd: (result: DropResult) => void;
    };

function getStandardAppBarButtonClassName({
  isActive = false,
  className,
}: {
  isActive?: boolean;
  className?: string;
}) {
  return cn(
    appBarItemBaseClassName,
    'cursor-pointer',
    isActive
      ? 'bg-brand/20 text-brand hover:bg-brand/20'
      : 'bg-primary text-normal hover:bg-brand/10',
    className
  );
}

function getHostButtonClassName({
  host,
  isActive,
}: {
  host: AppBarHost;
  isActive: boolean;
}) {
  const isOffline = host.status === 'offline';

  return cn(
    appBarItemBaseClassName,
    isOffline
      ? 'bg-primary text-low opacity-50 cursor-not-allowed'
      : isActive
        ? 'bg-brand/20 text-brand cursor-pointer hover:bg-brand/20'
        : host.status === 'unpaired'
          ? 'bg-primary text-warning cursor-pointer hover:bg-warning/10'
          : 'bg-primary text-normal cursor-pointer hover:bg-brand/10'
  );
}

export function AppBar({
  projects,
  hosts = [],
  onPairHostClick,
  activeHostId = null,
  onCreateProject,
  onCommonTasksClick,
  onWorkspacesClick,
  onChatClick,
  onHostClick,
  showWorkspacesButton = true,
  onProjectClick,
  onProjectsDragEnd,
  isSavingProjectOrder,
  isWorkspacesActive,
  isChatActive = false,
  workspacesBadges,
  chatBadges,
  isCommonTasksActive = false,
  activeProjectId,
  isSignedIn,
  isLoadingProjects,
  onHoverStart,
  onHoverEnd,
  notificationBell,
  userPopover,
  appVersion,
  updateVersion,
  onUpdateClick,
}: AppBarProps) {
  const sections: AppBarSection[] = [];

  const projectSectionItems: AppBarSectionItem[] = [];

  if (isLoadingProjects) {
    projectSectionItems.push({ key: 'projects-loading', kind: 'loading' });
  }

  if (projects.length > 0) {
    projectSectionItems.push({
      key: 'project-list',
      kind: 'project-list',
      projects,
      activeProjectId,
      isSavingProjectOrder,
      onProjectClick,
      onProjectsDragEnd,
    });
  }

  if (isSignedIn) {
    projectSectionItems.push({
      key: 'create-project',
      kind: 'icon-button',
      label: 'Create project',
      icon: PlusIcon,
      onClick: onCreateProject,
      className: 'bg-primary text-muted hover:text-normal hover:bg-surface',
      wrapperClassName: 'pt-base',
    });
  }

  if (projectSectionItems.length > 0) {
    sections.push({
      key: 'projects',
      label: 'Projects',
      items: projectSectionItems,
      dividerAfter: true,
    });
  }

  if (showWorkspacesButton) {
    sections.push({
      key: 'local',
      label: 'Chat',
      items: [
        {
          key: 'local-workspaces',
          kind: 'icon-button',
          label: 'Workspaces',
          icon: LayoutIcon,
          isActive: isWorkspacesActive,
          onClick: onWorkspacesClick,
          badges: workspacesBadges,
        },
        {
          key: 'local-chat',
          kind: 'icon-button',
          label: 'Chat',
          icon: ChatCircleIcon,
          isActive: isChatActive,
          onClick: onChatClick,
          badges: chatBadges,
        },
      ],
    });
  }

  if (onCommonTasksClick) {
    sections.push({
      key: 'common-tasks',
      label: 'Tasks',
      items: [
        {
          key: 'common-tasks',
          kind: 'icon-button',
          label: 'Common Tasks',
          icon: ClockClockwiseIcon,
          isActive: isCommonTasksActive,
          onClick: onCommonTasksClick,
        },
      ],
    });
  }

  if (hosts.length > 0 || onPairHostClick) {
    sections.push({
      key: 'remote',
      label: 'Remote',
      items: [
        ...hosts.map((host) => ({
          key: `host-${host.id}`,
          kind: 'host-button' as const,
          host,
          isActive: host.id === activeHostId,
          onClick: () => {
            if (host.status === 'offline') {
              return;
            }

            onHostClick?.(host.id, host.status);
          },
        })),
        ...(onPairHostClick
          ? [
              {
                key: 'pair-remote-device',
                kind: 'icon-button' as const,
                label: 'Pair a remote device',
                icon: LinkIcon,
                onClick: onPairHostClick,
                className:
                  'bg-primary text-muted hover:text-normal hover:bg-surface',
              },
            ]
          : []),
      ],
    });
  }

  function renderSectionItem(item: AppBarSectionItem): ReactNode {
    switch (item.kind) {
      case 'icon-button':
        return (
          <Tooltip content={item.label} side="right">
            <button
              type="button"
              onClick={item.onClick}
              className={cn(
                getStandardAppBarButtonClassName({
                  isActive: item.isActive,
                  className: item.className,
                }),
                'relative'
              )}
              aria-label={
                item.badges?.length
                  ? `${item.label} (${item.badges.map((b) => b.label).join(', ')})`
                  : item.label
              }
            >
              <item.icon className="size-icon-base" weight="bold" />
              {item.badges && item.badges.some((b) => b.count > 0) && (
                <span className="absolute -top-2 -right-1 z-10 flex gap-0.5">
                  {item.badges
                    .filter((b) => b.count > 0)
                    .map((b, i) => (
                      <span
                        key={i}
                        className={cn(
                          'min-w-[18px] h-[18px] px-1 rounded-full',
                          'text-2xs font-medium text-white border border-secondary',
                          'flex items-center justify-center',
                          getBadgeToneClassName(b.tone)
                        )}
                      >
                        {b.count}
                      </span>
                    ))}
                </span>
              )}
            </button>
          </Tooltip>
        );
      case 'host-button': {
        const isOffline = item.host.status === 'offline';

        return (
          <Tooltip
            content={`${item.host.name} · ${getHostStatusLabel(item.host.status)}`}
            side="right"
          >
            <div className="relative">
              <span
                className={cn(
                  'absolute -top-1 -right-1 z-10',
                  'w-3.5 h-3.5 rounded-full border border-secondary',
                  getHostStatusIndicatorClass(item.host.status)
                )}
                aria-hidden="true"
              />
              <button
                type="button"
                disabled={isOffline}
                onClick={item.onClick}
                className={getHostButtonClassName({
                  host: item.host,
                  isActive: item.isActive,
                })}
                aria-label={`${item.host.name} (${getHostStatusLabel(item.host.status)})`}
              >
                {getProjectInitials(item.host.name)}
              </button>
            </div>
          </Tooltip>
        );
      }
      case 'loading':
        return (
          <div className="flex items-center justify-center w-10 h-10">
            <SpinnerIcon className="size-5 animate-spin text-muted" />
          </div>
        );
      case 'project-list':
        return (
          <DragDropContext onDragEnd={item.onProjectsDragEnd}>
            <Droppable
              droppableId="app-bar-projects"
              direction="vertical"
              isDropDisabled={item.isSavingProjectOrder}
            >
              {(dropProvided) => (
                <div
                  ref={dropProvided.innerRef}
                  {...dropProvided.droppableProps}
                  className="flex flex-col items-center -mb-base"
                >
                  {item.projects.map((project, index) => (
                    <Draggable
                      key={project.id}
                      draggableId={project.id}
                      index={index}
                      disableInteractiveElementBlocking
                      isDragDisabled={item.isSavingProjectOrder}
                    >
                      {(dragProvided, snapshot) => (
                        <div
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          className="mb-base"
                          style={dragProvided.draggableProps.style}
                        >
                          <Tooltip content={project.name} side="right">
                            <button
                              type="button"
                              onClick={() => item.onProjectClick(project.id)}
                              className={cn(
                                appBarItemBaseClassName,
                                'cursor-grab',
                                snapshot.isDragging && 'shadow-lg',
                                item.activeProjectId === project.id
                                  ? ''
                                  : 'bg-primary text-normal hover:opacity-80'
                              )}
                              style={
                                item.activeProjectId === project.id
                                  ? {
                                      color: `hsl(${project.color})`,
                                      backgroundColor: `hsl(${project.color} / 0.2)`,
                                    }
                                  : undefined
                              }
                              aria-label={project.name}
                            >
                              {getProjectInitials(project.name)}
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {dropProvided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        );
    }
  }

  return (
    <div
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      className={cn(
        'flex flex-col items-center h-full min-h-0 overflow-y-auto p-base gap-base',
        'bg-secondary border-r border-border'
      )}
    >
      {sections.map((section) => (
        <Fragment key={section.key}>
          <AppBarSection label={section.label}>
            {section.items.map((item) => (
              <div
                key={item.key}
                className={
                  'wrapperClassName' in item ? item.wrapperClassName : undefined
                }
              >
                {renderSectionItem(item)}
              </div>
            ))}
          </AppBarSection>
          {section.dividerAfter && (
            <div className="h-px w-8 bg-border my-1" aria-hidden="true" />
          )}
        </Fragment>
      ))}

      {/* Bottom section: Notifications + User popover */}
      <div className="mt-auto pt-base flex flex-col items-center gap-4">
        {notificationBell}
        {userPopover}
        {updateVersion ? (
          <Tooltip content={`Update to v${updateVersion}`} side="right">
            <button
              type="button"
              onClick={onUpdateClick}
              className={cn(
                'flex items-center justify-center py-1 rounded-md w-10',
                'text-micro font-ibm-plex-mono font-medium leading-none',
                'bg-brand text-on-brand hover:bg-brand-hover',
                'transition-colors cursor-pointer'
              )}
            >
              Update
            </button>
          </Tooltip>
        ) : (
          appVersion && (
            <p
              className="text-micro font-ibm-plex-mono text-low leading-none w-10 text-center"
              title={`v${appVersion}`}
            >
              v{appVersion}
            </p>
          )
        )}
      </div>
    </div>
  );
}
