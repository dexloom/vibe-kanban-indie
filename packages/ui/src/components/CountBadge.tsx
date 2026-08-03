import { cn } from '../lib/cn';

interface CountBadgeProps {
  count: number;
  /** Cap shown when count exceeds the threshold (e.g. 99 -> "99+"). */
  cap?: number;
  /** `sm` (12px) for small icons like the bucket bar; `md` (18px) for the
   *  notification bell. */
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLASSES = {
  sm: 'h-3 min-w-3 px-0.5 text-[9px]',
  md: 'h-[18px] min-w-[18px] px-1 text-2xs',
} as const;

/**
 * Small pill-shaped count badge pinned to the top-right of a relative parent.
 * Hidden when count <= 0. The number is also conveyed via the parent's
 * aria-label, so the badge itself is aria-hidden to avoid double announcement.
 *
 * Color-agnostic: this component only lays out the pill; callers pass the
 * color classes (bell: `bg-brand-secondary text-white`; bucket bar: per-bucket
 * `bg-warning text-white`, etc.) via `className`. Keeps conflicting bg-*
 * classes out of the shared primitive (cn() is plain clsx, no tailwind-merge).
 */
export function CountBadge({
  count,
  cap = 99,
  size = 'md',
  className,
}: CountBadgeProps) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute -top-2 -right-2 flex items-center',
        'justify-center rounded-full font-medium',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {count > cap ? `${cap}+` : count}
    </span>
  );
}
