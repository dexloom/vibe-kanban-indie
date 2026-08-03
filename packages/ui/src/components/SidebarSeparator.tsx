import { cn } from '../lib/cn';

interface SidebarSeparatorProps {
  className?: string;
}

/**
 * Subtle horizontal divider for sidebar bars/sections (ADR-010 polish).
 * Decorative (aria-hidden), so it stays out of the a11y tree — no
 * `role="separator"` (that would contradict aria-hidden). `opacity-50`
 * keeps it quiet even though the border token is already low-contrast.
 */
export function SidebarSeparator({ className }: SidebarSeparatorProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('h-px w-full shrink-0 bg-border opacity-50', className)}
    />
  );
}
