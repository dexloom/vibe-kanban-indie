import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { CountBadge } from './CountBadge';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

export interface SidebarBarButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visible text under the icon (also the default accessible name). */
  label: string;
  icon: PhosphorIcon;
  /** Tailwind text-color token applied to the icon. */
  iconClass?: string;
  /** Count badge (hidden when <= 0). */
  badgeCount?: number;
  /** Tailwind classes for the badge (bg + text). */
  badgeClass?: string;
}

/**
 * Shared sidebar bar button (ADR-010): vertical icon + small label + optional
 * count badge. Used by the top bucket bar (ADR-009, via DropdownMenuTrigger
 * asChild) and the bottom Notifications/Settings bar. Layout only carries
 * `flex-col` — width is up to the caller (`flex-1` on the bucket bar, natural
 * width at the bottom). Extends button attributes and spreads `...rest` so a
 * Radix `asChild` trigger can attach its own props (pointer handlers,
 * aria-expanded, data-state).
 */
export const SidebarBarButton = forwardRef<
  HTMLButtonElement,
  SidebarBarButtonProps
>(function SidebarBarButton(
  { label, icon: Icon, iconClass, badgeCount, badgeClass, className, ...rest },
  ref
) {
  const count = badgeCount ?? 0;
  const ariaLabel =
    rest['aria-label'] ?? (count > 0 ? `${label} — ${count}` : undefined);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      {...rest}
      className={cn(
        'relative flex flex-col items-center justify-center gap-0.5 rounded-sm',
        'h-10 px-1 cursor-pointer transition-colors',
        'text-normal hover:bg-accent hover:text-high',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        className
      )}
    >
      <span className="relative">
        <Icon className={cn('size-4 shrink-0', iconClass)} weight="bold" />
        {count > 0 && (
          <CountBadge size="sm" count={count} className={badgeClass} />
        )}
      </span>
      <span className="max-w-full truncate text-2xs font-medium leading-none text-low">
        {label}
      </span>
    </button>
  );
});

// Satisfy `DropdownMenuTrigger asChild` typing.
export default SidebarBarButton;
