import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useEffect, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { cn } from '../lib/cn';

const STORAGE_KEY_PREFIX = 'vibe.ui.collapsible.';

function getInitialExpanded(
  persistKey: string | undefined,
  defaultExpanded: boolean
) {
  if (!persistKey || typeof window === 'undefined') return defaultExpanded;
  try {
    const stored = window.localStorage.getItem(
      `${STORAGE_KEY_PREFIX}${persistKey}`
    );
    if (stored == null) return defaultExpanded;
    return stored === 'true';
  } catch {
    return defaultExpanded;
  }
}

export type SectionAction = {
  icon: Icon;
  onClick: () => void;
  isActive?: boolean;
  /** Accessible label / tooltip for the icon button. */
  title?: string;
};

interface CollapsibleSectionHeaderProps {
  persistKey?: string;
  title: string;
  defaultExpanded?: boolean;
  collapsible?: boolean;
  actions?: SectionAction[];
  headerExtra?: ReactNode;
  children?: ReactNode;
  className?: string;
  /**
   * id for the controls/aria relationship between the header button and its
   * collapsible panel. Defaults to the `persistKey` so call sites that only
   * pass `persistKey` get correct a11y wiring for free. Stable string only —
   * changing this on every render will re-key the DOM region.
   */
  controlsId?: string;
  /**
   * Forwarded to the toggle button when `collapsible` is true. Used by tree
   * outliners (WorkspaceOutliner) to participate in a roving tabIndex.
   */
  tabIndex?: number;
  /**
   * Forwarded to the toggle button's `role` attribute. Defaults to undefined
   * (the implicit `button` role). Tree parents pass `role="treeitem"` so the
   * header participates in tree keyboard navigation.
   */
  role?: string;
  /**
   * Controlled expanded state. When provided, the header ignores its own
   * localStorage-backed state and renders strictly from this prop. Pair with
   * {@link onToggle} to update the parent. Use this when a sibling component
   * needs to read the current expanded state (e.g. the WorkspaceOutliner's
   * keyboard navigation hook).
   */
  expanded?: boolean;
  /**
   * Called when the user clicks the toggle button. When `expanded` is
   * controlled (`expanded` prop provided), the parent MUST update it; the
   * header will not toggle its own state.
   */
  onToggle?: () => void;
}

export const CollapsibleSectionHeader = forwardRef<
  HTMLButtonElement,
  CollapsibleSectionHeaderProps
>(function CollapsibleSectionHeader(
  {
    persistKey,
    title,
    defaultExpanded = true,
    collapsible = true,
    actions = [],
    headerExtra,
    children,
    className,
    controlsId,
    tabIndex,
    role,
    expanded: expandedProp,
    onToggle,
  },
  ref
) {
  const isControlled = expandedProp !== undefined;

  // `useState` with a lazy initializer is the single source of truth for the
  // initial expanded state. Do NOT add a `useEffect` that re-derives the
  // initial value on prop changes — that would clobber a user's manual toggle
  // when the parent re-renders with a fresh (but identical) `defaultExpanded`
  // identity. Callers MUST pass stable identities for `persistKey` and
  // `defaultExpanded`.
  const [internalExpanded, setInternalExpanded] = useState(() =>
    getInitialExpanded(persistKey, defaultExpanded)
  );

  const expanded = isControlled ? expandedProp : internalExpanded;
  const setExpanded = (next: boolean | ((prev: boolean) => boolean)) => {
    if (isControlled) {
      // Controlled mode: defer to the parent's toggle handler (the prop
      // update will arrive on the next render). We still synchronously invoke
      // the callback so the parent can update its state in response to the
      // user click — without this, controlled mode would never toggle.
      if (typeof onToggle === 'function') {
        onToggle();
      }
      return;
    }
    setInternalExpanded((prev) =>
      typeof next === 'function' ? next(prev) : next
    );
  };

  useEffect(() => {
    if (!persistKey || isControlled) return;
    try {
      window.localStorage.setItem(
        `${STORAGE_KEY_PREFIX}${persistKey}`,
        String(expanded)
      );
    } catch {
      // Ignore localStorage failures (private mode/quota/security errors).
    }
  }, [persistKey, expanded, isControlled]);

  const handleActionClick = (
    e: MouseEvent<HTMLSpanElement>,
    onClick: () => void
  ) => {
    e.stopPropagation();
    onClick();
  };

  const handleActionKeyDown = (
    e: KeyboardEvent<HTMLSpanElement>,
    onClick: () => void
  ) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };

  const isExpanded = collapsible ? expanded : true;
  const regionId = controlsId ?? persistKey;

  const headerContent = (
    <>
      <span className="font-medium truncate text-normal">{title}</span>
      <div className="flex items-center gap-half">
        {headerExtra}
        {actions.map((action, index) => {
          const ActionIcon = action.icon;
          return (
            <span
              key={index}
              role="button"
              tabIndex={0}
              title={action.title}
              aria-label={action.title}
              onClick={(e) => handleActionClick(e, action.onClick)}
              onKeyDown={(e) => handleActionKeyDown(e, action.onClick)}
              className={cn(
                'hover:text-normal',
                action.isActive ? 'text-brand' : 'text-low'
              )}
            >
              <ActionIcon className="size-icon-xs" weight="bold" />
            </span>
          );
        })}
        {collapsible && (
          <CaretDownIcon
            weight="fill"
            className={cn(
              'size-icon-xs text-low transition-transform',
              !expanded && '-rotate-90'
            )}
          />
        )}
      </div>
    </>
  );

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <div className="">
        {collapsible ? (
          <button
            ref={ref}
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            aria-controls={regionId}
            tabIndex={tabIndex}
            role={role}
            className={cn(
              'flex items-center justify-between w-full px-base py-half cursor-pointer'
            )}
          >
            {headerContent}
          </button>
        ) : (
          <div
            className={cn(
              'flex items-center justify-between w-full px-base py-half'
            )}
          >
            {headerContent}
          </div>
        )}
      </div>
      {isExpanded && children && regionId && (
        <div id={regionId} role="group">
          {children}
        </div>
      )}
      {isExpanded && children && !regionId && children}
    </div>
  );
});
