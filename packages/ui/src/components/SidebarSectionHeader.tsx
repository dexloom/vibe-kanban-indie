import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface SidebarSectionHeaderProps {
  /** Plain string title (no JSX). Locked by contract. */
  title: string;
  /** Optional right-aligned action slot (e.g. ghost icon button). */
  actions?: ReactNode;
  /** Optional left adornment before the title. */
  leading?: ReactNode;
  /** Stable id for the <h2>. If omitted, a useId() is generated. */
  titleId?: string;
  className?: string;
}

export function SidebarSectionHeader({
  title,
  actions,
  leading,
  titleId,
  className,
}: SidebarSectionHeaderProps) {
  const autoId = useId();
  const id = titleId ?? autoId;
  return (
    <div
      className={cn(
        'flex h-7 shrink-0 items-center justify-between gap-1',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {leading}
        <h2
          id={id}
          className="m-0 truncate text-xs font-semibold uppercase tracking-wide text-low"
        >
          {title}
        </h2>
      </div>
      {actions && (
        <div className="flex items-center gap-0.5">{actions}</div>
      )}
    </div>
  );
}