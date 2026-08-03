import {
  type Icon as PhosphorIcon,
  ClockIcon,
  MoonIcon,
  WarningIcon,
} from '@phosphor-icons/react';

export type BucketId = 'attention' | 'running' | 'idle' | 'archived';
export type BarBucketId = Exclude<BucketId, 'archived'>;

export interface BucketMeta {
  id: BucketId;
  order: number;
  defaultOpen: boolean;
  /** ADR-006 legacy per-bucket localStorage key (first-run migration only). */
  legacyKey: string;
  /** i18n key under common.json. */
  labelKey: string;
  /** Tailwind text-color token for the icon. Optional (archived has no icon). */
  iconClass?: string;
  /** Tailwind bg/text classes for the count badge. */
  badgeClass?: string;
  hideBadge?: boolean;
  icon?: PhosphorIcon;
}

export const BUCKETS: Record<BucketId, BucketMeta> = {
  attention: {
    id: 'attention',
    order: 0,
    defaultOpen: true,
    legacyKey: 'workspaces-outliner-attention',
    labelKey: 'workspaces.outliner.attention',
    icon: WarningIcon,
    iconClass: 'text-warning',
    badgeClass: 'bg-warning text-white',
  },
  running: {
    id: 'running',
    order: 1,
    defaultOpen: true,
    legacyKey: 'workspaces-outliner-running',
    labelKey: 'workspaces.running',
    icon: ClockIcon,
    iconClass: 'text-success',
    badgeClass: 'bg-success text-white',
  },
  idle: {
    id: 'idle',
    order: 2,
    defaultOpen: true,
    legacyKey: 'workspaces-outliner-idle',
    labelKey: 'workspaces.idle',
    icon: MoonIcon,
    iconClass: 'text-low',
    badgeClass: 'bg-tertiary text-white',
    hideBadge: true,
  },
  archived: {
    id: 'archived',
    order: 3,
    defaultOpen: false,
    legacyKey: 'workspaces-outliner-archived',
    labelKey: 'workspaces.archived',
  },
};

export const BUCKET_ORDER: readonly BucketId[] = Object.values(BUCKETS)
  .sort((a, b) => a.order - b.order)
  .map(({ id }) => id);

export const BAR_BUCKET_ORDER: readonly BarBucketId[] = BUCKET_ORDER.filter(
  (id): id is BarBucketId => id !== 'archived'
);

export type BarBucketMeta = BucketMeta & {
  id: BarBucketId;
  icon: PhosphorIcon;
  iconClass: string;
  badgeClass: string;
};

export const BAR_BUCKETS = Object.fromEntries(
  BAR_BUCKET_ORDER.map((id) => [id, BUCKETS[id]])
) as Record<BarBucketId, BarBucketMeta>;

export const BUCKET_DEFAULT_OPEN: Record<BucketId, boolean> =
  Object.fromEntries(
    BUCKET_ORDER.map((id) => [id, BUCKETS[id].defaultOpen])
  ) as Record<BucketId, boolean>;

export const LEGACY_BUCKET_PERSIST_KEYS: Record<BucketId, string> =
  Object.fromEntries(
    BUCKET_ORDER.map((id) => [id, BUCKETS[id].legacyKey])
  ) as Record<BucketId, string>;
