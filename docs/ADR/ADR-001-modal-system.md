# ADR-001: Modal system — pure props-in/result-out dialogs with a provider-boundary bridge

- **Status**: Accepted
- **Date**: 2026-08-02

## Context

The "New Issue" flow opened a heavyweight right-sidebar create composer. We wanted a
clean, reusable modal for basic issue creation. Two structural constraints surfaced:

1. `ActionsProvider` is mounted at the app root (`packages/local-web/src/routes/_app.tsx`),
   **above** `ProjectProvider` (`packages/web-core/src/pages/kanban/ProjectKanban.tsx`).
   Action executors that live at the root (command-bar actions, keyboard shortcuts) cannot
   read `ProjectContext` (it is `null` there).
2. `@ebay/nice-modal-react` dialogs portal at their `Provider`, which is also high in the
   tree. A dialog rendered there cannot use `useProjectContext()` / `useOrgContext()`.
3. `React.StrictMode` is on; effect-driven modal opening double-fires in dev.

## Decision

Adopt a reusable modal system built on the existing `defineModal<P, R>` wrapper
(`@ebay/nice-modal-react`) with one governing rule:

> A dialog is a pure function of its props — data in via `show(props)`, result out via
> `resolve(result)`. It never reads deep-tree context (`ProjectContext`/`OrgContext`).

- **Pure dialog**: props carry all data; results are discriminated unions
  (e.g. `{ action: 'created'; issueId } | { action: 'canceled' }`). Every close path
  (cancel, Esc, overlay) resolves — never leave a dangling promise.
- **Provider-boundary bridge**: project-scoped flows gather data inside the provider
  subtree and thread it into the dialog as props/callbacks. Concretely,
  `ProjectMutationsRegistration` (rendered inside `ProjectProvider`) exposes a
  `createIssue(options) → Promise<issueId | null>` mutation registered upward on
  `ProjectMutations`; `ActionsProvider` becomes a thin shim calling it. Actions and
  shortcuts therefore work from any elevation.
- **Imperative opening only**: never open a modal from `useEffect`. `Dialog.show()` is
  called from event handlers / action executors, which StrictMode never double-fires.

## Consequences

- Positive: dialogs are trivially reusable and typed; the command bar, hotkeys, kanban
  buttons and sub-issue actions all share one create path; StrictMode-safe; the
  `ProjectMutations` registry is the single place project-scoped modal flows plug in.
- Negative: a dialog cannot reach into project state directly — callers must gather and
  pass data (slightly more plumbing, but explicit).
- Ongoing: new project-scoped modal flows (create sub-issue, bulk edit, create tag)
  follow the same pattern: extend `ProjectMutations` + bridge, keep the dialog pure.
