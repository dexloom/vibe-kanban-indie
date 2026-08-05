/**
 * Shared test fixture: representative target-ids spanning every shape the
 * cross-surface drag resolver may receive. Both the ui and web-core test
 * suites import this file (the ui test imports it directly; web-core's
 * test imports it via relative path) so the two grammar predicates stay
 * in lockstep — `isTreeStatusTarget(id) === !isColumnLikeTarget(id)`
 * must hold for every entry.
 *
 * Do NOT import this from production code: the file is in the ui source
 * tree only so both packages can reach it through their relative-path
 * test runners.
 */
export const SHARED_TARGET_ID_FIXTURE: readonly string[] = [
  // Bare UUID kanban-column target.
  '11111111-1111-4111-8111-111111111111',
  // Tree-status target.
  'project-1:status:todo',
  // Non-status colon segments (tasks / workspaces / bucket:*).
  'project-1:tasks',
  'project-1:workspaces',
  'project-1:bucket:sprint-42',
  // Edge id that the unanchored predicate misclassifies (multiple colons
  // in the trailing segment) — the anchored regex handles it correctly.
  'project-1:status:x:y',
  // Bare word / leaf id.
  'workspace-42',
  // Empty / whitespace.
  '',
];
