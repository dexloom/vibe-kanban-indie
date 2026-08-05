import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

interface SidebarBarProps {
  children: ReactNode;
  /** Accessible name for the toolbar. When set, the row gets `role="toolbar"`. */
  'aria-label'?: string;
  className?: string;
}

/**
 * Shared horizontal button row for the sidebar bars (ADR-010): the top
 * workspace-bucket bar and the bottom Notifications/Settings bar compose the
 * same visual row. Layout only — children decide what the buttons do.
 */
export function SidebarBar({
  children,
  'aria-label': ariaLabel,
  className,
}: SidebarBarProps) {
  return (
    <div
      role={ariaLabel ? 'toolbar' : undefined}
      aria-label={ariaLabel}
      className={cn('flex shrink-0 items-center gap-1', className)}
    >
      {children}
    </div>
  );
}
