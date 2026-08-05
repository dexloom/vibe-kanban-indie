/**
 * UI-side mirror of the web-core `<projectId>:status:<statusId>` target-id
 * grammar (see `packages/web-core/src/shared/lib/targetId.ts`).
 *
 * `packages/ui` cannot import web-core, so this predicate duplicates the
 * small string-sniff rule the controller needs to decide whether to
 * compute a card insertion index (kanban columns carry one, tree-status
 * targets don't). Keep the two files in sync — they define the same
 * grammar.
 *
 * NOTE: this returns true for ANY non-tree-status id, including
 * `proj:tasks`, `proj:bucket:x`, `workspace-42`. It does NOT mean
 * "kanban column" — it means "any non-tree-status target is treated as
 * a column for the controller's insertion-index resolver". The
 * resolveDragEnd layer (web-core) is the one that validates against
 * real status ids; here the controller only needs to know whether to
 * bother with the card-slot lookup at all.
 */
const TREE_STATUS_PATTERN = /^([^:]+):status:(.+)$/;

export function isColumnLikeTarget(targetId: string): boolean {
  return !TREE_STATUS_PATTERN.test(targetId);
}

/**
 * DOM-attribute discriminator for drop-target elements. Cards carry
 * `data-drop-target-status` (the status they sit in); columns do not.
 * This is the single source of truth for that rule — the controller's
 * `collectTargets` queried the same attribute but rebuilt the check
 * inline. Use these helpers anywhere you need to branch on the kind.
 */
export function isCardTarget(el: HTMLElement): boolean {
  return el.hasAttribute('data-drop-target-status');
}
