import { cn } from '../lib/cn';

/**
 * Feather Caret — the Vibe Kanban Indie brand mark.
 *
 * Stacked chevron barbs read as a feather and also as a terminal
 * fast-forward `>>>` caret. Strokes use `currentColor` so the mark
 * inherits whatever accent the surrounding theme provides.
 */
export function FeatherCaret({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={(size * 100) / 124}
      height={size}
      viewBox="0 0 100 124"
      fill="none"
      aria-hidden="true"
      className={cn('flex-none', className)}
    >
      <g
        stroke="currentColor"
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M50 12 L50 112" />
        <path d="M50 42 L30 25 M50 42 L70 25" />
        <path d="M50 72 L26 51 M50 72 L74 51" />
        <path d="M50 102 L24 80 M50 102 L76 80" />
      </g>
    </svg>
  );
}

/**
 * The VIBE KANBAN wordmark with the bordered INDIE tag, on a single line.
 * Header tier (VIBE / KANBAN) and the INDIE tag are kept deliberately
 * small so the lockup stays compact in the navbar.
 */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex items-baseline gap-1.5 font-ibm-plex-mono select-none',
        className
      )}
    >
      <span className="text-[13px] font-extrabold leading-none tracking-[0.12em] text-high">
        VIBE
      </span>
      <span className="text-[13px] font-extrabold leading-none tracking-[0.12em] text-brand">
        KANBAN
      </span>
      <span className="self-center rounded-[2px] border border-border px-1 py-px text-[7px] font-semibold leading-none tracking-[0.25em] text-low">
        INDIE
      </span>
    </span>
  );
}

/**
 * Full lockup: feather caret beside the wordmark. Used where both the
 * mark and the wordmark should appear together.
 */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <FeatherCaret size={20} className="text-brand" />
      <BrandWordmark />
    </span>
  );
}
