# ADR-016: Board-scoped orchestrator prompts

- **Status**: Implemented
- **Date**: 2026-08-06
- **Relates to**: ADR-013 (project subprojects / boards), ADR-012 (custom drag-and-drop)

## Context

The orchestrator is a **global singleton** coding agent (`crates/server/src/routes/workspaces/create.rs`
`spawn_orchestrator`) that monitors the whole kanban and works any project/board. It runs from a
fixed `~/.vibe-kanban/orchestrator` folder, has no project binding (`McpContext.project_id` is
`None`), and resolves a project per card it acts on. Its behavior is an **external plugin**
(`--agent vibe-kanban-indie:orchestrator`, sombrax_plugins — NOT in this repo).

Owners want **per-project and per-board (subproject) orchestrator prompts**: the orchestrator uses
the project's prompt when working on that project, and the board's prompt when working on that
specific board. Prompts must be **editable from the sidebar tree** and **applied live** — editing
must NOT require restarting the orchestrator session.

Two design options were considered:
- **(a) Spawn-time injection** — embed the prompt in the spawn `/loop 5m` prompt. Rejected: the
  spawn prompt is a fixed per-tick pointer (`orchestratorOptions.ts:79-96`); it can't know which
  board the orchestrator will touch, and editing would require teardown + respawn.
- **(b) Per-tick MCP read** — a MCP tool returns the resolved prompt for the active card's project
  each tick. Accepted: editing is live (no restart), one source of truth.

## Decision

Per-project / per-board orchestrator prompts stored on `projects`, exposed via a dedicated
GET/PUT + resolve endpoint, read by the orchestrator **per tick** through a new MCP tool, and
edited from a new sidebar tree node that opens a content pane.

### Storage

- `projects.orchestrator_prompt TEXT NOT NULL DEFAULT ''` — one column, no separate table, no
  versioning (YAGNI for a solo-dev tool). Root project row = project prompt; leaf board row =
  board prompt.
- Empty string = "no prompt at this scope" → resolution walks the parent chain, then falls back
  to the orchestrator's built-in behavior.

### Migration discipline

- New migration `crates/db/migrations/20260806000001_add_project_orchestrator_prompt.sql`,
  `ALTER TABLE ADD COLUMN ONLY`.
- **Table recreation is forbidden** — ADR-013 data-loss trap: sqlx runs migrations inside a
  transaction where `PRAGMA foreign_keys = OFF` is a no-op, so `DROP TABLE projects` triggers an
  implicit `DELETE` that cascades into child tables.
- The migration file is **frozen on commit**; the SHA-384 guard in `crates/db/src/lib.rs` rejects
  byte drift on macOS/Linux.

### API surface

- `GET /v1/projects/{id}/orchestrator-prompt` — the **raw** local value for this project.
- `PUT /v1/projects/{id}/orchestrator-prompt` — body `{ "orchestrator_prompt": string }`,
  **REPLACE semantics** (no deep-merge — it's a flat string), `""` clears. Bumps txid.
- `GET /v1/projects/{id}/orchestrator-prompt/resolve` — the **resolved** prompt walking the
  parent chain (see below), with provenance.
- Wire list `Project` gains `has_orchestrator_prompt: bool` ONLY — the body never ships on the
  list shape (keeps `GET /v1/projects`, the Electric snapshot, and `sidebarProjects` lean).

### Resolve semantics (server-side, single source of truth)

> **Amended 2026-08-06 — stack semantics.** The original "first non-empty
> wins" resolution was replaced with a STACK: every non-empty prompt in the
> parent chain contributes a labeled section, so a board with both a
> board-level and a project-level prompt receives BOTH (board first,
> project last), not one-or-the-other. See the **Resolve semantics
> (stack amendment)** subsection below for the current contract; the
> paragraphs in this block are retained as the historical (pre-amendment)
> spec.

Walk `parent_id` chain `self → nearest ancestor → … → root`; **first non-empty wins**. Cap 16
hops (mirrors `derive_key_chain`); cycle-guard via a seen-set. All-empty ⇒ `""` with
`source: "default"`.

Provenance shape: `{ project_id, orchestrator_prompt, source_project_id: Option<Uuid>,
source: "self" | "ancestor" | "default" }`. `source_project_id` is the row that supplied the
text (`None` on default).

### Resolve semantics (stack amendment)

The orchestrator must receive BOTH the board-level refinement AND the
project-level baseline when both are set — "board OR project" loses
information the owner explicitly wants composed. The resolver now
**collects every non-empty prompt** walking `self → root`, labels each by
role (`[Board: …]` for non-root rows, `[Project: …]` for the root row),
and renders them most-specific-first into a single `orchestrator_prompt`
string with a fixed mandatory preamble embedded (so the external plugin
needs zero changes — it consumes only the string):

```
<orchestrator_prompt_stack>
This is a STACK of scoped orchestrator prompts, ordered most-specific
first (board-level) to broadest last (project-level). MANDATORY: follow
every section. On a direct conflict between sections, the earlier
(more-specific) section overrides the later (broader) one. Where there
is no conflict, all sections apply additively; the project-level
section is the baseline that always holds.

[Board: <board prompt text>]

[Project: <project prompt text>]
</orchestrator_prompt_stack>
```

Rules:
- Each present scope contributes exactly one section; absent scopes are
  omitted (a board with no board prompt but a set project prompt resolves
  to just `[Project: …]`; the root resolved directly resolves to just
  `[Project: …]` since it IS the project level).
- Cycle / hop-overflow / missing-row ⇒ `("", None)` — corrupt chains
  never produce a partial stack (preserves the pre-amendment abort
  semantics; keeps the cycle-guard test honest).
- Whitespace-only prompts are treated as absent (same as before).
- Cap 16 hops, cycle-safe via a seen-set (unchanged).

Provenance (`source_project_id` / `source`) is unchanged at the
**top-of-stack** granularity — it identifies the MOST-SPECIFIC section
(the first non-empty row in walk order). `source = "self"` when the
queried row itself contributed a section, `"ancestor"` when only parents
did, `"default"` when the stack is empty. This keeps the frontend
editor's "Inherited from an ancestor project" / "Using default behavior"
badges correct without a wire change: the badges describe what the
editor's empty-textarea state resolves to, which is exactly what
`source` encodes.

The MCP tool (`get_orchestrator_prompt`) and the wire
`ResolvedOrchestratorPromptResponse` shape are unchanged — the stack is
embedded in the existing `orchestrator_prompt: String` field. The
external sombra_plugins orchestrator plugin consumes only that string
plus `source`, so the stack amendment requires **no out-of-repo change**.

### MCP tool

- `get_orchestrator_prompt(project_id: Uuid)` — `project_id` is REQUIRED (the orchestrator
  context has no implicit project id).
- Registered in `orchestrator_mode_router` ONLY (card-scoped agents must not read sibling
  prompts). New file `crates/mcp/src/task_server/tools/orchestrator_prompt.rs`.
  **Amended 2026-08-08 — see "MCP-mode reachability amendment" below: the tool is now
  registered in BOTH routers; global-mode registration is the reachable one.**
- **Cross-repo contract**: the external sombra_plugins orchestrator MUST call
  `get_orchestrator_prompt` with the current card's `project_id` at the start of every tick, MUST
  NOT cache across ticks (edits apply live), and MUST treat `source: "default"` as "no custom
  instruction — use built-in behavior". Recorded as an issue in sombra_plugins.

### MCP-mode reachability amendment (2026-08-08)

The original registration ("orchestrator_mode_router ONLY") made the tool **unreachable in
practice**: the sombra_plugins orchestrator's `.mcp.json` runs `npx vibe-kanban-indie --mcp`
with **no `--mode` flag**, so it connects in global mode — the one mode that did NOT expose
the prompt tool. Orchestrator mode additionally lacks `list_workspaces` / `start_workspace`,
so no single MCP mode could both read board prompts and drive a sweep. (The plugin's working
path today is the REST resolve endpoint, which needs no mode change; this amendment is a
coherence fix, not an unblock.)

**Decision (option (a) of card VIBE-5):** register `get_orchestrator_prompt` in
`global_mode_router` (and keep it in `orchestrator_mode_router` so a `--mode orchestrator`
launch stays coherent). The original sibling-prompt restriction is dropped, because:

1. **Mode was never an isolation boundary.** Card-scoped agents also connect in global mode
   (the default), and nothing ever launched an MCP server with `--mode orchestrator` — the
   restriction isolated the tool from its only intended consumer while protecting nothing.
2. **Prompts are not secrets.** They are owner-authored plain text in a local, auth-less
   SQLite DB, already readable by any local process via
   `GET /api/projects/<id>/orchestrator-prompt/resolve`. This is a solo-dev fork; there is no
   confidentiality boundary to enforce.
3. **The residual concern is prompt-following, not tool access.** A card-scoped agent could
   read a sibling board's prompt, but the text is inert unless the agent chooses to act on
   it — and the tool requires an explicit `project_id` the card agent has no reason to
   supply. The tool description scopes its intended use (orchestrator per-tick read).

Option (b) — completing orchestrator mode with `list_workspaces` + issue tools and switching
the plugin to `--mode orchestrator` — was rejected: it is a larger change, touches the
plugin's dispatch primitive (`run_issue_in_workspace` instead of `start_workspace`), and buys
an isolation boundary that (per points 1–3) does not exist.

The wire contract is unchanged: `source: "default"` still means "no prompt at any scope —
use built-in behavior", and the stack rendering is untouched. Exact tool-name-set tests now
cover BOTH routers (`global_mode_exposes_the_full_card_surface` — extended to include
`get_orchestrator_prompt`, and `orchestrator_mode_exposes_only_scoped_workflow_tools`), plus a
positive reachability assertion (`orchestrator_prompt_tool_is_reachable_in_global_mode`).

### Sidebar tree

- New top-level node type `OrchestratorPromptNode` in the `SidebarTreeNode` union
  (`type: 'orchestrator-prompt'`, leaf — no children, no toggle, no open-state persistence).
- `ProjectNode.children` widens to `(SectionNode | ProjectNode | OrchestratorPromptNode)[]`.
- Inserted **after the Tasks section, before child boards** — for BOTH root projects and boards.
- Rendered **only when the project/board has a prompt** (`has_orchestrator_prompt` is true) —
  the owner rejected always-visible; a project with no prompt shows no node, and the `+` menu is
  the only entry point to add one. When present, `hasPrompt: boolean` on the node drives a
  brand-colored indicator dot (source = wire `Project.has_orchestrator_prompt`). Resolved
  inheritance is NOT shown in the dot — the editor pane shows the "Inherited from {name}" badge.
- The existing `+` on project rows (root and board — boards already have it) becomes a Radix
  DropdownMenu with two items: **"Add board"** and **"Add orchestrator prompt"**. "Add …" is
  accurate here — the menu is the creation entry point for a project that has no prompt yet;
  the node appears only after the prompt is saved.

### Editor pane

- Route `/projects/:projectId/orchestrator-prompt` → `OrchestratorPromptEditor`.
- New `AppDestination` kind `project-orchestrator-prompt`; `sidebarMode: 'closed'` (full-pane
  editor, not a kanban side panel).
- Editor UX: textarea seeded from the raw GET; **explicit Save button** (no autosave — prompts are
  low-frequency, autosave makes "did I commit a draft?" ambiguous) + **Clear** button (writes `""`).
- Save state machine `idle | saving | saved | error`.
- "Inherited from {name}" badge when raw is empty and `resolve.source === 'ancestor'`; "Using
  default behavior" when `source === 'default'` and raw is empty.

## Consequences

### Positive

- Prompts are live-editable without restarting the orchestrator (per-tick MCP read).
- One source of truth (server-side chain resolution) shared by the MCP tool and the editor.
- Small surface: one column, one migration, three endpoints, one MCP tool, one tree node type,
  one route + editor.

### Negative / accepted

- The orchestrator plugin (sombra_plugins, out of repo) must be updated to call the new MCP tool
  each tick — a cross-repo dependency.
- Editing while the orchestrator is mid-tick: the next read gets the new value; last-write-wins
  for concurrent tabs (acceptable solo-dev).
- A prompt that is empty after `.trim()` is treated as empty for resolution (stored raw).

### Risks

- Silent prompt cycle in the parent chain — mitigated by cap + seen-set.
- Orchestrator plugin drift from the per-tick contract — mitigated by this ADR + a sombra_plugins
  issue.
- Wire `Project` widening (`has_orchestrator_prompt`) breaks stale caches — mitigated by txid bump
  on PUT.

## Not in scope (deferred)

- Per-status prompts, prompt templating/variables, prompt history/audit, multi-org prompts
  (local-only fork has one org).

## TO RESOLVE

- None — all design questions resolved in the synthesis (storage, API, MCP tool, tree node,
  editor, fallback order, migration discipline).
- Follow-up: update the sombra_plugins orchestrator to call `get_orchestrator_prompt` per tick.
- ~~**Cross-repo canary (open)**~~ **(closed 2026-08-08 — MCP-mode reachability
  amendment).** The canary's premise was that the orchestrator reads the prompt
  ONLY via the MCP tool, so a sombra_plugins regression (stops calling it)
  would slip silently. That premise no longer holds: the plugin deliberately
  reads via `GET /api/projects/<id>/orchestrator-prompt/resolve` (no mode
  change needed), and the MCP tool is a second, now-reachable path to the same
  server-side resolver. The contract is "read the resolved prompt per tick",
  not "call this specific transport" — a transport-specific canary would lock
  the plugin to one wire for no benefit. The resolver itself is covered by
  `crates/db` chain-walk tests and the `mcp_get_orchestrator_prompt_*` wire
  tests.

## Implementation order (TDD)

1. Phase A — migration + `Project.orchestrator_prompt` + `update_orchestrator_prompt` +
   `resolve_orchestrator_prompt` + GET/PUT/resolve handlers + `has_orchestrator_prompt` wire field.
2. Phase B — MCP tool `get_orchestrator_prompt` (orchestrator_mode_router only).
3. Phase C — tree node type + buildTreeData insert + DropdownMenu `+` + `OrchestratorPromptTreeNode`.
4. Phase D — route + `OrchestratorPromptEditor`.
5. Phase E — this ADR + sombra_plugins issue.

Resource note: development runs on a laptop — run targeted tests (per-crate `cargo test -p db -p
server`, per-file vitest) instead of the full suite unless required.

## Implementation status

Implemented as specified (2026-08-05). Phased A→E landed via TDD:

- **A1–A3** — `projects.orchestrator_prompt TEXT NOT NULL DEFAULT ''` via
  migration `20260806000001_add_project_orchestrator_prompt.sql` (safe
  ADD COLUMN, no table recreation). `Project::update_orchestrator_prompt`
  is a dedicated PUT path; `Project::resolve_orchestrator_prompt` walks
  the parent chain with a 16-hop cap and a `HashSet` cycle guard.
- **A4** — `api_types::Project::has_orchestrator_prompt: bool` +
  `OrchestratorPromptResponse`, `ResolvedOrchestratorPromptResponse`,
  `OrchestratorPromptSource` (`self`/`ancestor`/`default`), and
  `UpdateOrchestratorPromptRequest`. `to_api_project` is updated in
  both `routes/local_kanban.rs` and `routes/kanban.rs`.
- **A5** — `GET /v1/projects/{id}/orchestrator-prompt`,
  `PUT /v1/projects/{id}/orchestrator-prompt`, and
  `GET /v1/projects/{id}/orchestrator-prompt/resolve`. PUT bumps txid.
- **B** — `get_orchestrator_prompt` MCP tool in
  `crates/mcp/src/task_server/tools/orchestrator_prompt.rs`, registered
  in `orchestrator_mode_router` only.
- **C** — `OrchestratorPromptNode` leaf, `hasOrchestratorPrompt` on
  `SidebarProject`, `_dot` brand indicator, `+` menu
  (`<PlusIcon …>` trigger + `<DropdownMenu>` with "Add board" +
  "Orchestrator prompt"). Uniform order at every depth: `[Tasks,
  OrchestratorPrompt, ...childBoards, Workspaces]`.
- **D** — `AppDestination::project-orchestrator-prompt`,
  `goToProjectOrchestratorPrompt`, route
  `/projects/:projectId/orchestrator-prompt`,
  `OrchestratorPromptEditor` with explicit Save / Clear state machine
  and the two badges.

### Deviations from the ADR

- **Stack amendment (2026-08-06)** — resolve semantics changed from
  "first non-empty wins" to "collect every non-empty prompt into a
  labeled stack" (board-first / project-last, with a mandatory preamble
  embedded in the returned string). Driven by owner requirement: a board
  must receive BOTH its board-level refinement AND the project-level
  baseline, not one-or-the-other. `resolve_orchestrator_prompt` in
  `crates/db/src/models/project.rs` builds the stack; the
  `render_orchestrator_prompt_stack` helper renders it. Wire shape and
  `source` enum are unchanged (provenance now describes the
  top-of-stack). See the **Resolve semantics (stack amendment)**
  subsection above for the full contract. No external-plugin change
  required.
- **Editor "Inherited from {name}" badge** reads "Inherited from an
  ancestor project" instead of the resolved project's name. The
  resolved id is captured (`source_project_id`) but the editor does not
  fetch the supplying project's row to render its name — a deliberate
  scope cut (one fewer request per editor mount, no name-lookup
  coupling). The name can be added in a follow-up without touching the
  wire contract.
- **No editor React test in `web-core`** — `web-core` ships only
  node-environment vitest tests (no `@testing-library/react` dependency);
  adding the dep would have been a scope expansion. The editor's
  state-machine contract is covered by the navigation predicate test
  (`sidebarMode: 'closed'`, `isPanelOpen: false`) and the in-process
  preview of the route file. Manual smoke + the e2e shell command will
  catch regressions.

The sombra_plugins follow-up (per-tick `get_orchestrator_prompt` call)
remains out-of-repo.
