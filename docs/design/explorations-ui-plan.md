# VibeCrew UI Plan — "Explorations" Design Review & Implementation Roadmap

Date: 2026-07-08
Sources:

- Claude Design project **"Vibe Kanban window system"** (`b241cf98-cb16-412c-b6cb-45bec5399e6c`)
  - [`Explorations.dc.html`](./Explorations.dc.html) — 8 design directions across 3 iteration turns (reviewed here)
  - [`VibeKanbanOneWindow.dc.html`](./VibeKanbanOneWindow.dc.html) — baseline one-window layout (sidebar switcher + workspaces view + live agent strip)
- Migration plan: [`docs/frontend-ui-library-refactor-audit.md`](../frontend-ui-library-refactor-audit.md) — `@vibe/ui` package extraction

## 0. Where we are

The migration plan is **substantially executed**: the canonical design system now lives in
`packages/ui` (`@vibe/ui`, ~180 components) and the app shell runs entirely on it via
`packages/web-core/src/shared/components/ui-new/containers/` (6 wiring containers, incl.
`SharedAppLayout.tsx`, `NavbarContainer.tsx`). The deprecated `components/ui` primitive layer is
gone. **Rule for all work below (migration-plan compliance):**

- New *presentational* components → `packages/ui/src/components/` (no `@/stores`, `@/contexts`, API imports).
- New *wiring/state* → `packages/web-core/src/shared/` (containers, hooks, stores) or a `features/*` slice.
- New backend types → annotate with `#[derive(TS)]`, register in
  `crates/server/src/bin/generate_types.rs`, run `pnpm run generate-types`. Never edit `shared/types.ts`.

The baseline "One Window" layout from the design project is also already real:
persistent `AppBar` sidebar (Workspaces + draggable project list), TanStack file routes,
3-pane `WorkspacesLayout` (sidebar / conversation / Changes-Logs-Preview), ⌘K command bar,
global approvals WS stream, per-host workspaces WS stream.

### The one structural gap every "bold" direction hits

There is **no cross-project aggregate of live agent activity**. Execution-process streaming is
per-session (`/api/execution-processes/stream/session/ws`), and the broadest live feed is the
per-host workspaces stream (`crates/server/src/routes/workspaces/streams.rs`) which only carries
`isRunning` / `latestProcessStatus`. Mission Control, Agent Dock, Telemetry Rail and Flight
Recorder all need one shared foundation (Phase 0 below).

## 1. Review of the 8 directions

Legend: value = for the single-dev, multi-agent cockpit workflow this fork targets.

| # | Direction | Design tag | Value | Effort | Verdict |
|---|-----------|-----------|-------|--------|---------|
| 1c | ⌘K Command Palette | subtle | high | **S** — palette exists; add verbs | **Adopt now** (Phase 1) |
| 2b | Activity Inbox | subtle | high | M | **Adopt** (Phase 2) |
| 1a | Agent Dock | subtle | high | M (needs Phase 0) | **Adopt** (Phase 3) |
| 3a | Mission Control | bold | high | M–L (needs Phase 0 + log tails) | **Adopt** (Phase 4) |
| 3b | Split Focus (pinned session) | subtle | med–high | M | **Adopt** (Phase 5) |
| 1b | Card Peek (expand in place) | bold | med | L | **Later** — reuse Phase 5 components; ship as board-level peek after 3b |
| 1d | Telemetry Rail | bold | med | L (needs metrics) | **Partial/Later** — fold the useful 20% into the Dock; sparklines/tok-s optional |
| 2a | Flight Recorder | bold | low–med | XL | **Defer** — revisit once `events.rs` history retention is proven |

### 1c · ⌘K Command Palette — adopt now

Design: spawn agents on issues, move cards between columns, jump to any workspace/session with
live state shown inline (`Running · 43%`), footer hints `↵ run`, `⌘↵ run + open session`.

Reality: `CommandBarDialog` + `shared/command-bar/actions/pages.ts` already cover workspace
lifecycle, git, issue mutations, view toggles. Missing vs the design:

- **"Spawn agent on ISSUE-N"** as a first-class root verb (today it's buried in issue flows).
- **"Move ISSUE-N → column"** quick action from anywhere.
- **Jump-to entries decorated with live state** (running dot, %, branch) — needs only the
  existing workspaces stream, no new backend.
- `⌘↵` secondary-action convention (run + open session).

### 2b · Activity Inbox — adopt

Design: third sidebar destination **Inbox** with amber badge; "Needs you / All activity" tabs;
triage cards (plan approval → **Review plan**, MCP/tool failure → **Open session**, diff ready →
**Open diff**) with inline actions; quiet "Earlier" history; per-project amber badges.

Reality anchors: `useApprovals` (global WS stream), `WorkspacesSidebar` raised-hand bucketing
(`hasPendingApproval` / `hasUnseenActivity` / `latestProcessStatus: failed`), Electric-backed
`useNotifications` + `NotificationsPage` (route `_app.notifications`). This direction is mostly a
**unification**: one local-first inbox that merges approvals + failures + review-ready diffs +
completions, instead of the current split between the bell (remote notifications) and the
workspaces sidebar buckets.

### 1a · Agent Dock — adopt

Design: persistent bottom dock on every view; one tile per live agent (name, model, elapsed,
current tool line, progress, `needs review` flag); click → jump to session; replaces the live
strip in the workspaces table.

Reality: nothing global exists; needs Phase 0 aggregate + a `lastActivityLine` per running
process. UI is cheap once data exists. Must be collapsible (single toggle, persisted in
`useUiPreferencesStore`) — a solo dev with 0–1 agents running shouldn't pay 70px of chrome.

### 3a · Mission Control — adopt

Design: sidebar destination (or F3) showing **every session across all projects** as a live tile
grid — last 3 tool lines streaming, progress bar, waiting-on-you tiles with inline **Review
plan**, recent completions dimmed (`merged · +430 −120 · 9 turns`), dashed **Spawn agent** tile,
header `3 live · 1 waiting · 2 recent · Sorted by activity`.

Reality: the hardest data requirement — *N* concurrent normalized-log tails (one per running
session) for the streaming tool lines. Cheapest correct approach: extend the Phase 0 aggregate
snapshot with a rolling `recent_lines: Vec<ActivityLine>` (last ~3 tool/thinking lines per
process) maintained server-side, so ONE stream powers the whole grid — no client-side fan-out of
log websockets.

### 3b · Split Focus — adopt

Design: pin any session to the right edge from a card/row pin icon; board keeps working left;
pinned pane has Agent/Terminal/Changes tabs + composer; **persists across project/view switches**;
draggable divider; ✕ unpins.

Reality: `react-resizable-panels` is already the layout engine, and the entire session pane
(`WorkspacesMainContainer`, `SessionChatBoxContainer`, conversation virtualizer) exists. The work
is *hoisting*: a pinned-session slot rendered by `SharedAppLayout` (right of `<Outlet/>`), driven
by a `usePinnedSessionStore`, so it survives route changes. Also requires
`ExecutionProcessesProvider` to support a second, independently-selected session — today it holds
only the currently-selected one.

### 1b · Card Peek — later

Expanding a kanban card in place into the full live session is visually strong but duplicates
Split Focus's plumbing with higher layout risk (column compress/dim, Esc semantics, virtualizer
inside a growing card). After Phase 5, the session pane is embeddable; revisit Card Peek then as
`KanbanCardExpanded` reusing it. Interim: the existing `KanbanIssuePanel` plus Phase 1 live cards
covers 80% of the need.

### 1d · Telemetry Rail — partial, later

Per-agent sparklines, diff velocity, tok/s, 24h diff-heat. Requires a metrics time-series the
backend doesn't keep. The valuable core (which agent is hot, who's waiting, diff magnitude) is
already delivered by Dock + Mission Control. If wanted later: sample the Phase 0 aggregate
client-side into ring buffers for sparklines (zero backend change), and treat tok/s as a
nice-to-have executor metric.

### 2a · Flight Recorder — defer

Scrubbable multi-lane timeline of all sessions. Real forensic value ("what happened while I was
away?") but the Inbox answers the triage version of that question at ~10% of the cost. The
`events.rs` combined history+live SSE stream is the natural substrate if this is revived; defer
until retention/perf characteristics of that stream are proven.

## 2. Phase 0 — Foundation: Agent Activity aggregate (backend)

Everything bold hangs off this. **One new WS JSON-patch stream, host-scoped, cross-project.**

- `crates/server/src/routes/agent_activity.rs`:
  `GET /api/agent-activity/stream/ws` → stream of `AgentActivitySnapshot`:

  ```rust
  #[derive(TS, Serialize)]
  struct AgentActivityEntry {
      workspace_id: Uuid,
      project_id: Option<Uuid>,
      issue_code: Option<String>,          // e.g. "VIBE-14"
      workspace_name: String,
      branch: Option<String>,
      executor: Option<String>,            // model/agent label
      state: AgentActivityState,           // Running | WaitingApproval | Failed | Completed | Idle
      started_at: Option<DateTime<Utc>>,
      progress: Option<AgentProgress>,     // reuse /agent-progress todo counts
      recent_lines: Vec<ActivityLine>,     // last ≤3 tool/thinking lines (kind, text, ok/err)
      diff_stats: Option<DiffStats>,       // +adds −dels
      pending_approval_id: Option<Uuid>,
  }
  ```

  Implementation: join the existing workspaces stream state with running
  `execution_processes` + the `/agent-progress` snapshot logic; maintain `recent_lines` by
  tapping the normalized-log msg store per running process (bounded ring, server-side).
- Register types in `generate_types.rs`; `pnpm run generate-types`.
- Frontend: `shared/hooks/useAgentActivity.ts` (via `useJsonPatchWsStream`) +
  `shared/providers/AgentActivityProvider.tsx` mounted once in `_app.tsx`. Selectors:
  `liveEntries`, `waitingEntries`, `recentCompleted`, `countsByProject`.

Exit criteria: provider mounted, no UI yet; TUI (`crates/tui`) may later consume the same route.

## 3. Phased roadmap

Task IDs follow the existing `VIBE-N` convention; sizes S/M/L.

### Phase 1 — Quick wins (no new backend)

| Task | Scope | Size |
|------|-------|------|
| **VIBE-A1** Palette verbs | `Spawn agent on <issue>`, `Move <issue> → <column>` root actions in `command-bar/actions/pages.ts`; `⌘↵` = run + open session | S |
| **VIBE-A2** Live jump-to | Decorate palette Jump-to entries with running dot / % / branch from workspaces stream; add `Archived` state rows | S |
| **VIBE-A3** Live kanban cards | `KanbanCardContent`: progress bar + `n/m · %` (from agent-progress via issue→workspace link), pulsing dot, `needs review` amber state — per design cards `LOOM-14` | M |
| **VIBE-A4** Sidebar badges | Project rows in `AppBar`: green running-count badge, amber needs-attention badge (design: `Loom Pro 2`, `Voicy 1`) | S |

### Phase 2 — Activity Inbox (2b)

| Task | Scope | Size |
|------|-------|------|
| **VIBE-B0** Phase 0 foundation | `agent_activity.rs` + types + provider (see §2) | M |
| **VIBE-B1** `@vibe/ui` primitives | `InboxTriageCard` (icon/severity variants, inline action slot), `InboxHistoryRow`, `InboxTabs` | M |
| **VIBE-B2** Inbox route + container | `_app.inbox` route, sidebar destination with amber count badge; merge sources: pending approvals (**Review plan** → approval respond flow), failed processes (**Open session**), review-ready diffs (**Open diff** → Changes panel), completions/history below; `Needs you / All activity` filter; `Mark all read` (extend unseen-activity tracking) | M–L |
| **VIBE-B3** Reconcile with bell | Fold local inbox count into `AppBarNotificationBellContainer` or replace bell destination for local host | S |

### Phase 3 — Agent Dock (1a)

| Task | Scope | Size |
|------|-------|------|
| **VIBE-C1** `@vibe/ui` `AgentDock` + `AgentDockTile` | states: active (indigo, tool line + caret), progress (bar + %), attention (amber, `needs review`, `idle 4m`); `AGENTS · n live` gutter | M |
| **VIBE-C2** Dock container in `SharedAppLayout` | grid row under `<Outlet/>`; click → navigate to session; collapse toggle + auto-hide when 0 live (persist in `useUiPreferencesStore`); keyboard cycle (e.g. `⌥1..9`) | M |
| **VIBE-C3** De-duplicate | Remove/slim the workspaces-table live strip the dock supersedes (per design note) | S |

### Phase 4 — Mission Control (3a)

| Task | Scope | Size |
|------|-------|------|
| **VIBE-D1** `recent_lines` hardening | Bound + test server-side ring buffers; include err/ok line kinds (design shows `✕ list_projects · not registered`) | M |
| **VIBE-D2** `@vibe/ui` `SessionTile` | live (glow border, streaming lines, progress), waiting (amber + inline primary action), done (dimmed, `merged · +430 −120 · 9 turns`), dashed `Spawn agent` tile | M |
| **VIBE-D3** Route + grid | `_app.mission-control`, sidebar destination + `F3` shortcut (keyboard registry); header counts `n live · n waiting · n recent`, sort by activity; tile click → session; `Review plan` inline without leaving grid | M |

### Phase 5 — Split Focus (3b)

| Task | Scope | Size |
|------|-------|------|
| **VIBE-E1** Hoist session pane | Make the session view (conversation + tabs + composer) mountable outside the workspaces route; `ExecutionProcessesProvider` keyed by explicit session id (support 2 concurrent) | L |
| **VIBE-E2** Pinned pane | `usePinnedSessionStore` (session id + width, persisted); `SharedAppLayout` renders resizable pinned pane right of `<Outlet/>`; pin icons on kanban cards / workspace rows / session header; ✕ unpin; breadcrumb `project + session` per design | M |

### Phase 6 — Later / optional

- **VIBE-F1** Card Peek (1b) as `KanbanCardExpanded` reusing the hoisted session pane; Esc/✕ collapse, column dim.
- **VIBE-F2** Telemetry sparklines: client-side ring-buffer sampling of activity aggregate; optional tok/s from executors.
- **VIBE-F3** Flight Recorder (2a) spike on top of `events.rs` history — only if a concrete "what happened overnight" need survives the Inbox.

**Dependency chain:** Phase 1 → independent. Phase 2 needs B0. Phases 3–4 need B0. Phase 5
independent (heaviest refactor). Recommended order: **1 → 2 → 3 → 4 → 5 → 6**, one phase per
`VIBE-N` batch, releasable after every phase.

## 4. Cross-cutting notes

- **Visual language.** The mocks use bg `#0f1116/#0b0c10`, primary indigo `#6172f3`, success
  `#35c98e`, warning `#e6a44a`, danger `#f0616d`, purple `#b07cf0`, Geist Mono for data. Do **not**
  hardcode these: map to the existing HSL-var tokens in
  `packages/web-core/src/app/styles/new/index.css` (primary/success/warning/destructive + console
  vars). If the indigo-on-near-black look is wanted, ship it as a token-level dark-theme tune in
  one PR, not per-component colors. Mono-for-data (ids, branches, counters, tool lines) is a cheap,
  high-impact convention to adopt globally — the codebase already loads IBM Plex Mono; keep it
  rather than adding Geist Mono unless typography is deliberately revisited.
- **Animation.** Design's pulse/caret idioms (`vkpulse`, `vkcaret`) → add as shared keyframes in
  `@vibe/ui` (`RunningDots` already covers part); respect `prefers-reduced-motion`.
- **i18n.** All new strings through the existing locale files (`settings.*` precedent); en + all
  non-en locales in the same PR (see commit `ffa4f544` convention).
- **TUI parity.** `crates/tui` is the second cockpit: Phase 0's aggregate endpoint should be
  consumed by a TUI "mission control" screen later — keep the route TUI-friendly (plain WS JSON
  patches, no web-only assumptions).
- **Testing/verification.** Per repo guidelines: unit tests beside new Rust logic
  (`agent_activity` ring buffers, state derivation), `pnpm run check` + `lint`, Vitest for
  non-trivial stores (`usePinnedSessionStore`, inbox merge logic), `pnpm run format` before
  completion, `generate-types:check` in CI already guards drift.

## 5. Decisions taken in this plan (flag if wrong)

1. "Migration plan" = the `@vibe/ui` extraction audit; all new UI honors that boundary.
2. Solo-dev triage value ranked "subtle" directions above "bold" ones where they overlap
   (Inbox > Flight Recorder, Dock > Telemetry Rail).
3. Mission Control's streaming tool lines are served by ONE aggregate stream with server-side
   ring buffers, not N client log sockets.
4. Card Peek is sequenced after Split Focus because both need the same hoisted session pane.
