# ADR-003: Workspaces/Chat nav split — aggregate dashboard + smart redirect

- **Status**: Accepted
- **Date**: 2026-08-02
- **Amended by**: ADR-005 (left sidebar — Projects outlined group + collapsible "chats" tree). The domain module, dashboard, smart redirect, and destination/predicate model remain canonical; ADR-005 changes how they are hosted (rail → tree-in-sidebar) and how labels/badges are presented.

## Context

The left-rail nav had one button (labelled "Chat") whose target route `/workspaces`
immediately redirected to `/workspaces/create` (`WorkspacesLanding`). The single button
conflated two distinct entities: **workspaces** (status overview) and **chat**
(per-workspace agent conversations). The broad predicate `isLocalWorkspacesDestination`
matches four destination kinds (`workspaces | workspaces-create | workspace |
workspace-vscode`), so two buttons could not highlight independently. Chat is inherently
per-workspace (sessions/entries are workspace-scoped); there is no unified-inbox surface.

## Decision

- **Workspaces button** → `/workspaces` becomes a real aggregate **dashboard**
  (sections: Needs attention / Running / Recently active / Archived). `WorkspacesLanding`
  (create-redirect shim) is deleted.
- **Chat button** → new route `/chat` is a **smart redirect**: picks the most relevant
  workspace (needs-attention → running → most-recently-active → else `/workspaces/create`)
  and lands on `/workspaces/$workspaceId` (the existing per-workspace chat). No unified
  inbox (a separate, much larger epic if ever wanted).
- **Badges**: Workspaces button gets a green count pill (`isRunning`), Chat gets a red
  pill (needs-attention). `needsAttention(w) = w.hasPendingApproval ||
  (w.hasUnseenActivity && !w.isRunning)` — the canonical predicate already used by
  `WorkspacesSidebar`, promoted to a single source of truth.
- **New pure domain module** `shared/lib/workspaceStatus/` (no React): the needs-attention
  predicate, dashboard bucket categorization, `pickChatDestination`, badge-count
  computation, and a deterministic recency comparator (timestamps are ISO strings —
  `Date.parse`; tiebreak `latestProcessCompletedAt desc → createdAt desc → id desc`;
  per-bucket tiebreak for running/needs-attention uses `createdAt`).
- **Navigation extension**: add `{ kind: 'chat' }` to the `AppDestination` union, a
  resolver/target case for `/_app/chat`, `goToChat()` on `AppNavigation`, and two narrow
  predicates `isWorkspacesDashboardDestination` (kind `workspaces`) and
  `isWorkspaceChatDestination` (kind `chat | workspace`). `workspaces-create` highlights
  neither button. Exhaustive switches fail to compile until updated (intended).
- **Test-first**: the pure functions are written with Vitest cases before the UI wiring
  (staged: type/stub skeleton → red tests → implementation → green), following the
  existing `selectActiveWorkspace.test.ts` convention.
- Badge pills match the existing notification-bell pill style; `ChatLanding` snapshots its
  target once per mount (StrictMode/idempotency-safe) and only after the workspaces list
  finishes loading.

## Consequences

- Positive: `/workspaces` finally shows an informative list; the Chat button no longer
  dumps users into create; badge counts are live (WS stream + 15s summary refetch) and
  consistent with the sidebar's "Needs attention" section; the pure domain module is
  unit-testable.
- Negative: Chat is a launcher, not a unified inbox (accepted); `/chat` is not a
  bookmarkable URL to a specific workspace; deep-links to `/workspaces` now land on the
  dashboard instead of the create flow (strictly better).
- Ongoing: sidebar preview gating migrates to the chat predicate; the red badge lags up to
  15s unless approval-resolution invalidates the summary query.
