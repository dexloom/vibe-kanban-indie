import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Tree,
  type NodeApi,
  type NodeRendererProps,
  type TreeApi,
} from 'react-arborist';
import { SpinnerIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceKind } from 'shared/types';
import { cn } from '../lib/cn';
import {
  categorizeWorkspacesForOutliner,
  type WorkspaceStatusItem,
} from '../lib/workspaceStatus';

/** Compact Gmail-style relative time: "just now", "5m ago", "1d ago". */
function formatRelativeElapsed(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** A single workspace rendered as a leaf in the workspaces tree. */
export interface OutlinerWorkspace extends WorkspaceStatusItem {
  name: string;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  isRunning?: boolean;
  isPinned?: boolean;
  kind?: WorkspaceKind | null;
  hasPendingApproval?: boolean;
  hasRunningDevServer?: boolean;
  hasUnseenActivity?: boolean;
  latestProcessStatus?:
    | 'running'
    | 'completed'
    | 'failed'
    | 'killed';
  prStatus?: 'open' | 'merged' | 'closed' | 'unknown';
}

interface WorkspaceOutlinerProps {
  /** Active (non-archived) workspaces. */
  workspaces: OutlinerWorkspace[];
  /** Archived workspaces. */
  archivedWorkspaces?: OutlinerWorkspace[];
  /** ID of the currently active chat destination, if any. */
  activeWorkspaceId: string | null;
  isLoading?: boolean;
  onSelectWorkspace: (id: string) => void;
  /** Fixed width of the tree viewport (px). Defaults to the sidebar panel width. */
  width?: number;
  className?: string;
}

export interface WorkspaceOutlinerHandle {
  focus: () => void;
}

const PERSIST_KEYS = {
  attention: 'workspaces-outliner-attention',
  running: 'workspaces-outliner-running',
  idle: 'workspaces-outliner-idle',
  archived: 'workspaces-outliner-archived',
} as const;

type BucketId = keyof typeof PERSIST_KEYS;

interface BucketNode {
  id: BucketId;
  type: 'bucket';
  name: string;
  children: LeafNode[];
}

interface LeafNode {
  id: string;
  type: 'leaf';
  workspace: OutlinerWorkspace;
}

type OutlinerData = BucketNode | LeafNode;

const BUCKET_DEFAULT_OPEN: Record<BucketId, boolean> = {
  attention: true,
  running: true,
  idle: true,
  archived: false,
};

function readInitialOpenState(): Record<BucketId, boolean> {
  const out = { ...BUCKET_DEFAULT_OPEN };
  try {
    for (const bucketId of Object.keys(PERSIST_KEYS) as BucketId[]) {
      const raw = window.localStorage.getItem(
        `vibe.ui.collapsible.${PERSIST_KEYS[bucketId]}`
      );
      if (raw != null) {
        out[bucketId] = raw === 'true';
      }
    }
  } catch {
    // ignore storage failures (private mode / quota)
  }
  return out;
}

function OutlinerNode({ node, style, dragHandle }: NodeRendererProps<OutlinerData>) {
  if (node.data.type === 'leaf') {
    const ws = node.data.workspace;
    const isActive = node.isSelected;
    const elapsed = formatRelativeElapsed(ws.latestProcessCompletedAt);
    return (
      <div
        style={style}
        ref={dragHandle}
        role="treeitem"
        aria-selected={isActive}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => node.activate()}
        className={cn(
          'relative flex w-full cursor-pointer items-baseline gap-1.5 overflow-hidden px-1.5 text-left',
          'text-sm leading-7 focus:outline-none',
          isActive
            ? 'text-high font-semibold'
            : 'text-normal font-normal hover:text-high'
        )}
      >
        {/* Tree guide: vertical dotted line down the bucket + horizontal dotted
            tick connecting the guide to this leaf. Pure visual orientation. */}
        <span
          aria-hidden="true"
          className="absolute left-[5px] top-0 h-full w-px border-l-2 border-dotted border-border-strong/80"
        />
        <span
          aria-hidden="true"
          className="absolute left-[5px] top-1/2 h-px w-[7px] border-t-2 border-dotted border-border-strong/80"
        />
        <span className="truncate">{ws.name}</span>
        {elapsed && (
          <span className="shrink-0 text-xs text-low">{elapsed}</span>
        )}
        {ws.filesChanged != null && (
          <span className="shrink-0 text-xs text-muted">{ws.filesChanged}</span>
        )}
        {ws.linesAdded != null && ws.linesAdded > 0 && (
          <span className="shrink-0 text-xs text-success">+{ws.linesAdded}</span>
        )}
        {ws.linesRemoved != null && ws.linesRemoved > 0 && (
          <span className="shrink-0 text-xs text-error">−{ws.linesRemoved}</span>
        )}
      </div>
    );
  }

  // Bucket (branch) row.
  const bucket = node.data;
  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-expanded={node.isOpen}
      onClick={() => node.toggle()}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1 rounded-sm pr-1.5 text-left',
        'text-2xs font-medium uppercase tracking-wide text-low',
        'hover:bg-surface focus:outline-none',
        node.isFocused && 'bg-surface/60'
      )}
    >
      <CaretRightIcon
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90'
        )}
        weight="bold"
      />
      <span className="truncate">{bucket.name}</span>
      <span className="ml-auto text-2xs font-normal normal-case text-low opacity-70">
        {bucket.children.length}
      </span>
    </div>
  );
}

function useContainerHeight() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  return { containerRef: ref, height };
}

export const WorkspaceOutliner = forwardRef<
  WorkspaceOutlinerHandle,
  WorkspaceOutlinerProps
>(function WorkspaceOutliner(
  {
    workspaces,
    archivedWorkspaces = [],
    activeWorkspaceId,
    isLoading = false,
    onSelectWorkspace,
    width = 300,
    className,
  },
  ref
) {
  const { t } = useTranslation('common');

  const { attention, running, idle, archived } = useMemo(
    () => categorizeWorkspacesForOutliner(workspaces, archivedWorkspaces),
    [workspaces, archivedWorkspaces]
  );

  const treeData = useMemo<OutlinerData[]>(() => {
    const makeBucket = (
      id: BucketId,
      name: string,
      items: readonly OutlinerWorkspace[]
    ): BucketNode => ({
      id,
      type: 'bucket',
      name,
      children: items.map((workspace): LeafNode => ({
        id: workspace.id,
        type: 'leaf',
        workspace,
      })),
    });

    // Always render all four buckets so the tree outline is stable even when
    // a bucket is empty (e.g. "Running" with nothing running).
    return [
      makeBucket('attention', t('workspaces.outliner.active'), attention),
      makeBucket('running', t('workspaces.running'), running),
      makeBucket('idle', t('workspaces.idle'), idle),
      makeBucket('archived', t('workspaces.archived'), archived),
    ];
  }, [attention, running, idle, archived, t]);

  const [initialOpenState] = useState<Record<BucketId, boolean>>(
    readInitialOpenState
  );
  const treeRef = useRef<TreeApi<OutlinerData> | null>(null);
  const { containerRef, height } = useContainerHeight();

  const handleToggle = useCallback((id: string) => {
    const node = treeRef.current?.get(id);
    if (!node) return;
    try {
      window.localStorage.setItem(
        `vibe.ui.collapsible.${PERSIST_KEYS[id as BucketId]}`,
        String(node.isOpen)
      );
    } catch {
      // ignore storage failures
    }
  }, []);

  const handleActivate = useCallback(
    (node: NodeApi<OutlinerData>) => {
      if (node.data.type === 'leaf') {
        onSelectWorkspace(node.data.workspace.id);
      }
    },
    [onSelectWorkspace]
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (activeWorkspaceId) {
          treeRef.current?.get(activeWorkspaceId)?.focus();
        } else {
          const first = treeRef.current?.visibleNodes[0];
          first?.focus();
        }
      },
    }),
    [activeWorkspaceId]
  );

  const allBuckets = attention.length + running.length + idle.length + archived.length;

  return (
    <section
      aria-label={t('appBar.workspaces')}
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-2">
          <SpinnerIcon className="size-icon-sm animate-spin text-muted" />
        </div>
      ) : allBuckets === 0 ? (
        <span className="pl-base text-sm text-low opacity-60">
          {t('workspaces.noWorkspaces')}
        </span>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1">
          <Tree<OutlinerData>
            ref={treeRef}
            data={treeData}
            openByDefault={false}
            initialOpenState={initialOpenState}
            width={width}
            height={height}
            indent={12}
            rowHeight={(node) => (node.data.type === 'leaf' ? 28 : 24)}
            overscanCount={5}
            padding={2}
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            selection={activeWorkspaceId ?? undefined}
            onActivate={handleActivate}
            onToggle={handleToggle}
            aria-label={t('appBar.workspaces')}
          >
            {OutlinerNode}
          </Tree>
        </div>
      )}
    </section>
  );
});
