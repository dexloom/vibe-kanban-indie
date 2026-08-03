import {
  type Icon as PhosphorIcon,
  ClockIcon,
  MoonIcon,
  WarningIcon,
} from '@phosphor-icons/react';

import type { BucketId } from '../components/outliner/types';

/**
 * Global sidebar bucket bar (ADR-009). The three *active* workspace buckets
 * exposed as quick-access dropdowns at the top of the sidebar. `archived` is
 * intentionally excluded — it has its own section in the project tree.
 *
 * Pure data: no React, no i18n lookups, no side effects. Consumers
 * (currently only SidebarBucketBar) read the icon + color and resolve labels
 * via t() at render time so this file stays framework-agnostic.
 */
export type BarBucketId = Exclude<BucketId, 'archived'>;

export const BAR_BUCKET_ORDER: readonly BarBucketId[] = [
  'attention',
  'running',
  'idle',
] as const;

export interface BarBucketMeta {
  id: BarBucketId;
  /** i18n key under common.json. Reuses existing outliner labels. */
  labelKey: string;
  icon: PhosphorIcon;
  /** Tailwind text-color token applied to the icon only. */
  iconClass: string;
  /** Tailwind classes for the count badge (bg + text). Per-bucket colored
   *  (owner decision). Passed through to CountBadge's className. */
  badgeClass: string;
  /** Hide the count badge. Idle may hold hundreds of workspaces where a
   *  count is noise — only attention/running carry a badge. */
  hideBadge?: boolean;
}

export const BAR_BUCKETS: Record<BarBucketId, BarBucketMeta> = {
  attention: {
    id: 'attention',
    labelKey: 'workspaces.outliner.attention',
    icon: WarningIcon,
    iconClass: 'text-warning',
    badgeClass: 'bg-warning text-white',
  },
  running: {
    id: 'running',
    labelKey: 'workspaces.running',
    icon: ClockIcon,
    iconClass: 'text-success',
    badgeClass: 'bg-success text-white',
  },
  idle: {
    id: 'idle',
    labelKey: 'workspaces.idle',
    icon: MoonIcon,
    iconClass: 'text-low',
    badgeClass: 'bg-tertiary text-white',
    hideBadge: true,
  },
};
