# Vibe Kanban — native macOS app (sketch)

A native SwiftUI client for **vibe-kanban-indie**, talking to the existing local
Rust backend over HTTP + WebSocket. This is a *sketch*: every screen of the web
UI is scaffolded; the board, issue detail, and workspace/chat are wired to the
live backend, and the rest are first-pass placeholders (each marked `// sketch`).

> Status: **builds clean** (`xcodebuild`) and **all model tests pass**. It is a
> starting point for porting the web UI (`packages/local-web` + `web-core`) to AppKit/SwiftUI.

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

Start the backend from the repo root (`pnpm run dev` or `pnpm run backend:dev:watch`).
On startup it writes its port to **`$TMPDIR/vibe-kanban/vibe-kanban.port`** (JSON
`{"main_port":…}`); the app auto-discovers it. To point elsewhere, set an override
in **Settings → General** (a bare port like `8080`, or a full URL).

No auth — the local indie deployment is unsigned localhost.

## Architecture

| Layer | Where | Notes |
|---|---|---|
| Models | `Sources/VibeKanbanMac/Models` | `Codable` structs. **Board** entities mirror `shared/remote-types.ts` (served by `/v1/fallback/*`); **execution** entities mirror `shared/types.ts` (`/workspaces`, `/sessions`, `/execution-processes`, `/approvals`). All IDs are `String`. |
| Networking | `Sources/VibeKanbanMac/Networking` | `APIClient` (REST), `PortDiscovery`, `WebSocketStream` (→ `AsyncStream<LogMsg>`), `ConversationPatchApplier` (RFC-6902 → `[NormalizedEntry]`). |
| State | `App/AppState.swift` | `@Observable` connection + project list + selection. Board/workspace state in their own view models. |
| Features | `Sources/VibeKanbanMac/Features` | One folder per screen. |

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
