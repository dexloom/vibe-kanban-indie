import { cn } from "../lib/cn";

export interface PulsingDotProps {
  className?: string;
}

/**
 * A neat single pulsating dot used as a "working" indicator. Subtler than the
 * animated border, so it does not demand attention on every run.
 */
export function PulsingDot({ className }: PulsingDotProps) {
  return (
    <span className={cn("relative flex size-2 shrink-0", className)}>
      <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-75 animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-brand" />
    </span>
  );
}
