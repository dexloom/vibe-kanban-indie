import { cn } from '../lib/cn';

interface WorkspaceActivityTextProps {
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  className?: string;
}

/**
 * Compact diff-stats line: `12 +34 -7`. Returns null when there is nothing to
 * show. Rendered inside the outliner tree leaf and the sidebar bucket-bar
 * menu items so the two stay in lockstep (ADR-009). Extracted from
 * LeafNode.tsx.
 */
export function WorkspaceActivityText({
  filesChanged,
  linesAdded,
  linesRemoved,
  className,
}: WorkspaceActivityTextProps) {
  const hasFiles = filesChanged != null;
  const hasAdded = linesAdded != null && linesAdded > 0;
  const hasRemoved = linesRemoved != null && linesRemoved > 0;
  if (!hasFiles && !hasAdded && !hasRemoved) return null;

  return (
    <span
      className={cn('flex items-center gap-1.5 text-2xs text-muted', className)}
    >
      {hasFiles && <span>{filesChanged}</span>}
      {hasAdded && <span className="text-success">+{linesAdded}</span>}
      {hasRemoved && <span className="text-error">&minus;{linesRemoved}</span>}
    </span>
  );
}
