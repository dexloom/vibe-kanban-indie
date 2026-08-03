import { cn } from '../lib/cn';

interface CountBadgeProps {
  count: number;
  /** Cap shown when count exceeds the threshold (e.g. 99 -> "99+"). */
  cap?: number;
  className?: string;
}

/**
 * Small pill-shaped count badge pinned to the top-right of a relative parent.
 * Hidden when count <= 0. The number is also conveyed via the parent's
 * aria-label, so the badge itself is aria-hidden to avoid double announcement.
 *
 * Color-agnostic: this component only lays out the pill; callers pass the
 * color classes (bell: `bg-brand-secondary text-white`; bucket bar: per-bucket
 * `bg-error/15 text-error`, etc.) via `className`. Keeps conflicting bg-*
 * classes out of the shared primitive (cn() is plain clsx, no tailwind-merge).
 */
export function CountBadge({ count, cap = 99, className }: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute -top-2 -right-2 flex h-[18px] min-w-[18px] items-center',
        'justify-center rounded-full px-1 text-2xs font-medium',
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
