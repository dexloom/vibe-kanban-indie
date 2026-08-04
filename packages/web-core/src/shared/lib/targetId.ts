/**
 * Single source of truth for the target-id grammar consumed by the cross-
 * surface drag system (ADR-012). Two surfaces:
 *
 *  - `tree-status`: `<projectId>:status:<statusId>` (sidebar status row)
 *  - `kanban`: bare UUID status column (kanban board)
 *
 * The package boundary matters: `packages/ui` cannot import web-core, so
 * its own minimal `isColumnLikeTarget` helper lives in
 * `packages/ui/src/components/dnd/targetKind.ts` and MUST stay in sync
 * with `isTreeStatusTarget` here. If you change this grammar, change both
 * files in the same commit.
 */
export const TREE_STATUS_PATTERN = /^([^:]+):status:(.+)$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedTarget {
  surface: 'kanban' | 'tree-status';
  statusId: string;
  projectId?: string;
}

export function isTreeStatusTarget(targetId: string): boolean {
  return TREE_STATUS_PATTERN.test(targetId);
}

/**
 * Parse a targetId into one of two surfaces. Cards are NOT drop targets in
 * the cross-surface path: a UUID that matches a known issue id (the second
 * argument lets the caller consult its issue lookup) is rejected as
 * `null`. The grammar check is authoritative — a bare UUID that does NOT
 * match a known issue is classified as `kanban`.
 */
export function parseTargetId(
  targetId: string,
  isKnownIssueId: (id: string) => boolean
): ParsedTarget | null {
  const match = TREE_STATUS_PATTERN.exec(targetId);
  if (match) {
    return {
      surface: 'tree-status',
      statusId: match[2]!,
      projectId: match[1]!,
    };
  }
  if (!UUID_PATTERN.test(targetId)) return null;
  if (isKnownIssueId(targetId)) return null;
  return { surface: 'kanban', statusId: targetId };
}
