import { cn } from '../lib/cn';

export function RunningDots({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-[2px] shrink-0', className)}>
      <span className="size-dot rounded-full bg-brand animate-running-dot-1" />
      <span className="size-dot rounded-full bg-brand animate-running-dot-2" />
      <span className="size-dot rounded-full bg-brand animate-running-dot-3" />
    </div>
  );
}
