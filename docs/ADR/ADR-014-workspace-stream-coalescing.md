# ADR-014: Workspace-status stream coalescing — bound the re-render cascade at the app root

- **Status**: Accepted
- **Date**: 2026-08-05
- **Relates to**: ADR-003 (workspace status live badges, WS stream + 15s summary refetch)

## Context

`WorkspaceProvider` is mounted at the app root (`packages/local-web/src/routes/_app.tsx`)
and calls `useWorkspaces()`, which subscribes to two WebSocket JSON-Patch streams
(`/workspaces/streams/ws?archived=false|true`) via `useJsonPatchWsStream`. Every patch
calls `setData(next)`, producing a fresh `activeData` reference. `useWorkspaces` derives
`workspaces`/`archivedWorkspaces` with `useMemo` over that reference, the provider folds
those arrays into its `coreValue` context memo, and **every `useWorkspaceContext()`
consumer re-renders** — the whole kanban board, the sidebar outliner, and the heavy card
right pane (`KanbanIssuePanelContainer` → `KanbanIssuePanel`: WYSIWYG description editor,
property row, tags, pipeline, workspaces/relationships/sub-issues/comments sections).

When the orchestrator (or any long-running agent) is active, the stream emits status
patches in bursts. Each patch cascaded a full-tree reconcile on the main thread, which
produced two user-visible symptoms:

1. **Card right pane scroll "freezes"** — the main thread was saturated reconciling the
   panel tree multiple times per second, so the `overflow-y-auto` scroll container
   (`KanbanIssuePanel.tsx`) stuttered.
2. **Selections / checkboxes appear to "clear" immediately** — interaction state
   destabilized under the re-render storm (stale renders, Radix primitives losing focus
   / open state, clicks landing against a mid-reconcile tree). This was a state-
   management / re-render problem, not a checkbox-component bug.

The codebase had **already solved the identical problem for the diff stream**:
`WorkspaceProvider` batches diff patches through `requestAnimationFrame` into a Zustand
store (`useWorkspaceDiffStore`). The workspace *list* stream had never been given the
same treatment — that was the gap.

## Decision

Coalesce the workspace-status stream output inside `useWorkspaces` so the consumer tree
re-renders at most once per throttle window, regardless of how many JsonPatch messages
arrive:

- The derived `activeList` / `archivedList` are written into a `latestListsRef` on every
  render; a leading-edge + trailing-edge throttle (~300ms) flushes them to a coalesced
  state (`lists`) that the hook returns. Bursts collapse into a single reconciled render.
- **Connection / loading / error state stays unthrottled** — it flows straight through so
  disconnect/reconnect feedback remains immediate.
- ~300ms is imperceptible for status indicators (running dots, pending-approval,
  unseen-activity): the summary poll that backs the richer badges already runs every 15s.

This is deliberately localized to the single hook that runs once at the app root, so the
fix lifts off every consumer (context-backed and direct) without touching call sites.

## Consequences

- Positive: the orchestrator's status churn no longer re-renders the entire app on every
  patch; the card right pane scrolls smoothly; interaction state is stable. The pattern
  is consistent with the existing diff-stream batching.
- Negative: workspace status indicators lag up to ~300ms. Accepted (well within the 15s
  summary-poll budget; running/approval states do not require frame-accurate display).
- Ongoing: the heaviest panel (`KanbanIssuePanel`) still re-renders on each *coalesced*
  tick because it receives freshly-created render-prop callbacks from its container. If
  the residual ~3 renders/sec ever becomes noticeable, the follow-up is to memoize the
  panel view and stabilize those render slots with `useCallback` — deferred until
  measured as needed.
