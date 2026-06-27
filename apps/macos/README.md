# Vibe Kanban — native macOS app (sketch)

A native SwiftUI client for **vibe-kanban-indie**, talking to the existing local
Rust backend over HTTP + WebSocket. This is a *sketch*: every screen of the web
UI is scaffolded; the board, issue detail, and workspace/chat are wired to the
live backend, and the rest are first-pass placeholders (each marked `// sketch`).

> Status: **builds clean** (`xcodebuild`) and the **unit-test suite passes (65 tests)**.
> It is a starting point for porting the web UI (`packages/local-web` + `web-core`) to AppKit/SwiftUI.
>
> Tests (`Tests/VibeKanbanMacTests`) cover: wire decoding of every entity, request-body
> encoding (create/update/bulk/spec/approval), JSON + date coding, the `## Pipeline`
> markdown composer + composer-model metadata, the normalized-log patch applier, color
> parsing, backend mode/resolution/discovery, and the REST route-prefix contract
> (`/api/*` execution routes vs root `/v1/*` board routes). They run offline (no backend needed).

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
| Features | `Sources/VibeKanbanMac/Features` | One folder per screen. |

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
- **Settings**: General (live status + server version + port override + reconnect) and Agents (live availability via `/agents/check-availability`).

**First-pass placeholders (marked `// sketch`):** file tree, diff viewer, preview URL
bar, issue intake/pipeline/relationships/sub-issues/comments sections, Settings →
Editors/MCP/Data, notifications, export, multi-select bulk actions, rich-text (WYSIWYG)
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
