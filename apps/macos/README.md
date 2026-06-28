# Vibe Kanban — native macOS app (sketch)

A native SwiftUI client for **vibe-kanban-indie**, talking to the existing local
Rust backend over HTTP + WebSocket. This is a *sketch*: every screen of the web
UI is scaffolded; the board, issue detail, and workspace/chat are wired to the
live backend, and the rest are first-pass placeholders (each marked `// sketch`).

> Status: **builds clean** (`xcodebuild`) and the **unit-test suite passes (84 tests)**.
> It is a starting point for porting the web UI (`packages/local-web` + `web-core`) to AppKit/SwiftUI.
>
> Tests (`Tests/VibeKanbanMacTests`) cover: wire decoding of every entity, request-body
> encoding (create/update/bulk/spec/approval + project/repo/link settings bodies), JSON +
> date coding, the `## Pipeline` markdown composer + composer-model metadata, the
> normalized-log patch applier, color parsing, backend mode/resolution/discovery, the
> REST route-prefix contract (`/api/*` execution + repo routes vs root `/v1/*` board +
> project routes), the executor-config **schema parser** (field kinds + order), and the
> JSONValue deep get/set used to edit the profiles tree. They run offline (no backend needed).

## Requirements

- macOS 14+ (developed on macOS 26, Xcode 26.5, Swift 6.3)
- [XcodeGen](https://github.com/yonyz/XcodeGen) (`brew install xcodegen`) — the
  `.xcodeproj` is generated from `project.yml`, not checked in.

## Generate, build, open

```bash
cd apps/macos
xcodegen generate                       # -> VibeKanbanMac.xcodeproj
open VibeKanbanMac.xcodeproj            # then ⌘R in Xcode (SwiftUI Previews work)

# or headless:
xcodebuild -project VibeKanbanMac.xcodeproj -scheme VibeKanbanMac \
  -destination 'platform=macOS,arch=arm64' build
xcodebuild -project VibeKanbanMac.xcodeproj -scheme VibeKanbanMac \
  -destination 'platform=macOS,arch=arm64' test
```

The app is unsandboxed and ad-hoc signed so it can read the backend's port file
and reach `127.0.0.1` without a developer team.

## Connecting to the backend

On launch the app: **(1)** reuses a backend that's already running (port file at
`$TMPDIR/vibe-kanban/vibe-kanban.port`, or a manual override in Settings → General);
**(2)** otherwise, in **managed** mode, spawns its own server; **(3)** otherwise reports
that none is available. No auth — the local indie deployment is unsigned localhost.

### Built-in (managed) backend

`BackendManager` supervises the Rust `server` binary as a child process, so you don't
have to run `pnpm run dev` separately. Configure it in **Settings → Backend**:

- **Mode** — *Managed (built-in)* (default) or *External* (you run the server yourself).
- The server is spawned with `HOST=127.0.0.1`, `BACKEND_PORT=0` (auto-assign),
  `DISABLE_WORKTREE_CLEANUP=1`, `VK_DISABLE_BROWSER_OPEN=1`; the app polls the port file
  then `/health`, and sends SIGTERM on quit (`applicationWillTerminate`).

### Bundled backend (Rust built into the app)

The Rust backend lives in the **same repo** (`crates/server`), so no git submodule is
needed — the app's Xcode build compiles and embeds it:

- A **pre-build phase** runs `cargo build --release --bin server` (against the repo at
  `$SRCROOT/../..`) and stages the binary at `apps/macos/Backend/server`.
- A **post-compile phase** copies it into the app at `Contents/Resources/Backend/server`
  **and re-signs it** with `codesign --force --sign -`.
- So a normal `xcodebuild`/Xcode Run produces a **self-contained app** whose managed
  backend works with **zero configuration**.

> **Why the re-sign matters.** Cargo emits a *linker-signed* ad-hoc signature
> (`codesign` flags `0x20002`). When such a binary is executed from inside another
> signed `.app` bundle, AMFI kills it immediately with **SIGKILL (exit 137)** — the
> process dies before printing anything, so the app just reports the managed backend
> never came up. Replacing it with a proper ad-hoc signature (`codesign --force --sign -`,
> flags `0x2`) fixes this. The re-sign runs before Xcode's final bundle signing, which
> only re-seals `CodeResources` and leaves the nested binary's own signature intact.

First build is slow (cold Rust compile); afterwards cargo is incremental (near-no-op).
For fast UI-only iteration, skip it with `SKIP_BACKEND_BUILD=1 xcodebuild …`. If `cargo`
isn't on PATH the phase warns and the app still builds (falling back to the resolution
order below). The `apps/macos/Backend/` staging dir is gitignored. `scripts/build-backend.sh`
does the same staging manually if you prefer.

**Browser:** a release server normally auto-opens a browser; the backend now honors
`VK_DISABLE_BROWSER_OPEN` (set by the app) to suppress that — see `crates/server/src/main.rs`.

**Executable resolution order (managed mode):**
1. An explicit **executable path** (Settings → Backend) — an operator override wins.
2. The **bundled** binary at `Contents/Resources/Backend/server` (the zero-config default above).
3. `<repo>/target/release/server` or `…/debug/server` under the configured **repo path**
   (optionally `cargo build`-ed first if "build from source" is enabled).

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Models | `Sources/VibeKanbanMac/Models` | `Codable` structs. **Board** entities mirror `shared/remote-types.ts` (served by `/v1/fallback/*`); **execution** entities mirror `shared/types.ts` (`/workspaces`, `/sessions`, `/execution-processes`, `/approvals`). All IDs are `String`. |
| Networking | `Sources/VibeKanbanMac/Networking` | `APIClient` (REST), `PortDiscovery`, `WebSocketStream` (→ `AsyncStream<LogMsg>`), `ConversationPatchApplier` (RFC-6902 → `[NormalizedEntry]`). |
| State | `App/AppState.swift` | `@Observable` connection + project list + selection. Board/workspace state in their own view models. |
| Voice | `Sources/VibeKanbanMac/Voice` | Mic dictation via **Voicy** (see below). `VoicyDiscovery`, `VoicyClient` (actor), `DictationContext`/`DictationMode`, `DictationController`, `DictationCommands` (menu). The button is `Components/MicButton`. |
| Features | `Sources/VibeKanbanMac/Features` | One folder per screen. |

### Voice dictation (Voicy)

The 🎤 in the workspace chat composer (and the **Dictate … with Voicy** menu
commands, ⌥⌘D / ⌥⌘T) **open Voicy** — you do the dictation + refinement *in*
Voicy (it owns the microphone and speech-to-text, so this app needs no mic
entitlement), then click **"Send to vibe-kanban"** in Voicy and the prepared text
lands in the chat box for review.

- **Situations** (`DictationSituation`): the **chat composer** mic offers the
  three agent situations — *instruction*, *answer questionnaire*, *review/approve*
  (→ Voicy's Agents section); the **new-card composer** (`IssueComposerView`)
  Description mic offers *task* (→ Voicy's Voice→Coding Task composer). The
  app-menu commands cover the three chat situations.
- **Agent depends on the situation**: the three agent situations default to Voicy's
  seeded **`vibe-kanban`** agent and can be remapped per situation in **Settings →
  Voice** (pickers populated from Voicy's `GET /agents`, persisted in
  `VoiceAgentMap`). The resolved `agentId` rides in the session request and Voicy
  preselects that agent. *task* uses the Task composer (no agent).
- `VoicyClient` (actor) discovers Voicy's loopback server from
  `~/.voicy/voicy.port` (launching Voicy via `NSWorkspace` if needed), opens a
  session (`POST /dictate/session` with `{ context, mode, agentId? }`), then
  **polls** `GET /dictate/session/{id}` until the user's Send (`status: sent`) or
  cancel.
- The context (`DictationContext.chat`: workspace title + last ~5 conversation
  messages) is sent over IPC and used by Voicy both to **bias transcription** and
  to **brief the agent** (recent messages + keywords folded into its
  `{{projectContext}}`), so the agent is aware of the live conversation.
- The menu commands target the focused workspace's composer via
  `@FocusedValue(\.dictate)` (`DictationCommands`).
- `VoiceTests` pins the route contract, the camelCase context wire shape, and the
  session/poll flow. The Voicy IPC server lives on the
  `feature/ipc-dictation-server` branch of the Voicy repo (see its README →
  "Dictation IPC").

### Workspace panes

The workspace window is a 2-pane layout: a left sidebar (sessions + file tree)
and a **main pane** with a segmented switch — **Agent / Terminal / Logs / Changes
/ Preview** (`WorkspacePane` in `WorkspaceWindowView`).

- **Agent** — the conversation + approvals + composer.
- **Terminal** — embedded interactive terminal (see below).
- **Logs** — raw stdout/stderr from the execution's `raw-logs` WebSocket
  (`TerminalLogView`), ANSI-stripped and auto-scrolling, with copy.
- **Changes** — the live workspace **git diff** streamed over
  `/workspaces/{id}/git/diff/ws` (`DiffView`). The stream is RFC-6902 patches
  against `{ entries: { <repo>: { <file>: Diff } } }`; `DiffStreamApplier`
  reconstructs the per-repo file map and `WorkspaceViewModel` exposes the flat
  `[DiffEntry]`. Each file renders a collapsible unified diff computed from
  `old`/`new` content with Swift's `CollectionDifference` (`Diff.render()`),
  red/green lines, an A/D/M/R/C/P change badge, and +/- counts. Binary/omitted
  or very large files collapse to a stats summary. The diff is workspace-level
  (survives session switches) and tied to the window's lifetime.
- **Preview** — `WKWebView` pointed at a dev-server URL.

### Terminal pane (headed agents)

The **Terminal** tab (`Features/Workspace/TerminalPane.swift`) is a real,
interactive terminal embedded in the pane, attached to the **headed Claude Code
agent's tmux session**. A headed (interactive) agent runs under
`tmux new-session -d -s vk-<execId>`; any number of clients can attach.

- **Embedded (built-in):** an [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)
  `LocalProcessTerminalView` spawns the user's login shell and `exec`s
  `tmux attach -t vk-<execId>`. The login shell (`-l`) makes the user's PATH
  resolve Homebrew `tmux`, and `exec` makes the process exit cleanly when the
  session detaches/ends (→ a "Not attached" overlay with **Reconnect**). tmux is
  already required for headed mode, so this adds no new runtime dependency.
- **Open in iTerm2:** the button calls `POST
  /api/execution-processes/{id}/open-terminal` (`APIClient.openInteractiveTerminal`),
  the backend's existing external-terminal flow, which opens the configured
  emulator (iTerm2 on macOS) attached to the same session.
- **SwiftTerm is pinned to `1.11.2`** in `project.yml` — the last release before
  the Metal GPU backend (v1.12+), which needs the separately-downloaded Metal
  Toolchain. 1.11.2 builds with a stock Xcode.
- *Caveat:* tmux mirrors a window across all attached clients and sizes it to the
  smallest one, so the embedded view and an open iTerm2 window share a size.

### Route prefixes (important)

The backend router (`crates/server/src/routes/mod.rs`) serves two families of routes:

- **Execution / config / approval / spec routes are nested under `/api`** — e.g.
  `/api/workspaces`, `/api/sessions`, `/api/execution-processes/{id}/…`, `/api/approvals/…`,
  `/api/spec/generate`, `/api/info`, `/api/agents/check-availability`, `/api/health`, and the
  `*/ws` streams. Hitting these **without** the `/api` prefix falls through to the SPA
  catch-all (`/{*path}`) and returns `index.html` → the classic `Unexpected character '<'`
  JSON-decode failure.
- **Board "fallback" routes are served at the root** under `/v1/*` — e.g.
  `/v1/fallback/projects`, `/v1/issues`, `/v1/issues/bulk` (the web fallback transport hits
  absolute `/v1/...`, not `/api/...`).

`APIPathTests` pins this contract (via a `URLProtocol` stub) so a dropped prefix fails CI.

### Wire-format envelopes

- Board reads: `{ "<table>": [...] }`  (e.g. `{ "issues": [...] }`)
- Board mutations: `{ data, txid }`  (drag-to-move uses `POST /v1/issues/bulk`)
- Execution endpoints: `ApiResponse<T>` = `{ success, data, error_data, message }`
- Streams (`*/ws`): externally-tagged `LogMsg` — `{"Stdout":…}`, `{"JsonPatch":[…]}`, `{"Ready":true}`, `{"finished":true}`

## Interface inventory (web → macOS)

| Web origin | macOS view | Key components |
|---|---|---|
| `ProjectKanban` / `KanbanContainer` | `Features/Board/*` | `ScrollView`+`HStack` columns, `.draggable`/`.dropDestination` |
| `KanbanFilterBar` / `ViewNavTabs` | `KanbanFilterBar` | `.searchable`-style field, `Menu`, segmented `Picker` |
| `IssueListView` | `IssueListView` | native `Table` |
| `KanbanIssuePanel` | `IssueDetail/IssueDetailView` | `.inspector`, `Form`, `DisclosureGroup`, `Menu` |
| `WorkspacesLayout` | `Workspace/WorkspaceWindowView` | separate `WindowGroup(for:)`, `HSplitView` |
| `ConversationList` | `ConversationListView` | `ScrollViewReader` + message rows |
| `SessionChatBox` | `ChatInputView` | `TextEditor` + send (⌘↵) |
| `RightSidebar` | `RightInspector` | `TabView`: Logs / Changes / Preview (`WKWebView`) |
| `ChatApprovalCard` | `Approvals/ApprovalCardView` | tool / question / plan responders |
| `CommandBar` | `CommandPalette/CommandPaletteView` | ⌘K sheet |
| Settings | `Settings/SettingsView` | `Settings` scene + `TabView` |
| `NotificationsPage` / `ExportPage` | `Notifications` / `Export` | sheets from the sidebar toolbar |

## Performance / data flow

Project boards are cached as long-lived view models in `AppState` (`boards[projectId]`),
so switching projects is **instant** — the board renders immediately from cache and
data refreshes in the background (a small toolbar spinner shows activity; there is no
blocking full-screen loader). First load happens once (`loadIfNeeded`); manual refresh
re-fetches. Mutations (create / drag-to-move / edit) are **optimistic** — the UI updates
right away and reconciles with the server, reverting on error.

## Functional vs. first-pass

**Functional (live):**
- Project sidebar + **Workspaces** entry; instant project switching (cached boards).
- Kanban board: read, create, **drag-to-move**, edit; cards pinned to the top.
- **Add card** opens the right inspector as the full creation composer mirroring the web flow:
  basic fields **+ agent (executor) selection + model override + spec generation (`POST /spec/generate`)
  + pipeline stages** (the canonical 9). On create it appends the `## Pipeline` markdown block
  (`<!-- vk:pipeline:start/end -->`, with the `executor:"…"` directive line) to the description and
  writes `extension_metadata = { intake, pipeline }` exactly like the web composer.
- Issue detail inspector: title / status / priority / description edits; linked workspaces open the workspace window.
- **Workspaces list** (`/workspaces`): status, branch, state, open-in-window (double-click or button).
- Workspace window: sessions, conversation (normalized-logs stream), raw logs, chat follow-up, approval responses.
- **Settings**:
  - *General* — live status + server version + port override + reconnect.
  - *Backend* — managed/external mode, executable/repo paths, start/stop, log.
  - *Agents* — set the backend **default agent** (`config.executor_profile`: executor + variant,
    round-tripped through `/api/info` and saved with `PUT /api/config`); a per-agent
    **configuration editor** that mirrors the web's RJSF form — pick an agent + variant, edit its
    options through a **schema-driven form** (text / textarea / enum / tri-state boolean / string
    list / env map), and create/delete variants, all saved to `/api/profiles`. The forms are
    driven by the per-agent JSON Schemas in `shared/schemas/`, bundled into the app at build time
    (`Resources/Schemas/`). Plus live availability via `/agents/check-availability`.
  - *Projects* — create / rename / recolor / delete projects (`/v1/projects`), and link/unlink a
    project's **default repositories**. ⚠️ These live in scratch **`PROJECT_REPO_DEFAULTS`**
    (`/api/scratch/PROJECT_REPO_DEFAULTS/{projectId}`) — the same association the intake /
    workspace-start flow reads — **not** the `project_repos` table (which the indie web/MCP flows
    leave empty). Linked ids are cross-referenced against the `/api/repos` catalog for display.
    Mutations refresh the sidebar.
  - *Repositories* — register a local git checkout (`POST /api/repos`, with a folder picker),
    edit display name / default branch / setup·cleanup·dev-server scripts (`PUT /api/repos/{id}`),
    and delete (`DELETE /api/repos/{id}`; surfaces the 409 "in use" conflict).

**First-pass placeholders (marked `// sketch`):** file tree, diff viewer, preview URL
bar, issue intake/pipeline/relationships/sub-issues/comments sections, Settings →
MCP/Data, notifications, export, multi-select bulk actions, rich-text (WYSIWYG)
description editor.

## ⚠️ Verify: WebSocket vs. polling

The workspace conversation/logs use the `*/ws` streams. Some backend WS upgrades
may require a relay signature **even locally** — if streams close immediately,
the conversation will stay empty (approvals still work: they are **polled** every
2s via `/approvals/pending/{exec}`). When you run it against your backend, confirm
whether the normalized-logs/raw-logs WS connect locally:

- **They connect** → conversation + Logs tab populate live. Done.
- **They don't** → add a polling fallback for the conversation (e.g. periodic
  `/execution-processes/{id}/agent-progress`) and/or pass the relay signature.

Record the outcome here once verified.

## Next steps

- Real diff viewer from `/workspaces/{id}/git/diff/ws`.
- File tree (shell the worktree at `container_ref`, or add a backend listing).
- "Start agent" flow (`POST /workspaces/start`) — needs project repo selection
  via `/v1/projects/{id}/repos`.
- Assignee names (load org members from `/v1/organizations/{org}/members`).
- Wrap as a proper `.xcodeproj`/app bundle with sandbox + entitlements for distribution.
