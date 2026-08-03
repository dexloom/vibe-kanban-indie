import type { CSSProperties, ReactNode, Ref } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { cn } from '../../lib/cn';

interface TreeCaretRowProps {
  node: { isOpen: boolean; isFocused?: boolean; toggle(): void };
  style?: CSSProperties;
  dragHandle?: Ref<HTMLDivElement>;
  className?: string;
  children: ReactNode;
}

export function TreeCaretRow({
  node,
  style,
  dragHandle,
  className,
  children,
}: TreeCaretRowProps) {
  return (
    <div
      style={style}
      ref={dragHandle}
      role="treeitem"
      aria-expanded={node.isOpen}
      onClick={() => node.toggle()}
      className={cn(
        'group flex w-full cursor-pointer items-center gap-1 rounded-sm pr-1.5 text-left',
        'hover:bg-surface focus:outline-none',
        node.isFocused && 'bg-surface/60',
        className,
      )}
    >
      <CaretRightIcon
        className={cn(
          'size-2.5 shrink-0 text-low transition-transform duration-150',
          node.isOpen && 'rotate-90',
        )}
        weight="bold"
      />
      {children}
    </div>
  );
}
