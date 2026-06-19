# Changelog

All notable changes to **vibe-kanban-indie** are documented here. This fork is
local-only and single-developer focused; releases are cut by pushing a `v<version>`
tag that matches `npx-cli/package.json` (see `.github/workflows/release-indie.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Two built-in pipeline steps in the New Issue Pipeline control and the Pipeline-steps
  settings catalog: **Wait for approval** (pause and wait for the operator's decision
  before continuing) and **Update documentation** (update the docs the change affects).

### Changed

- `default_pipeline_steps()` reordered so **Orchestrate (auto-drive)** is the first item
  (its prompt no longer says "the stages above"); `Wait for approval` sits after `Review
  plan` and `Update documentation` after `Review code`. Regenerated `shared/types.ts`.

### Documentation

- New leading **Vibe Kanban Indie** docs chapter (`docs/indie/`) reviewing every fork
  divergence from upstream: `whats-different`, `architecture` (local-first, fallback
  transport, MCP modes), and `agents-and-pipelines`.
- New **Claude Code Plugins & Skills** integration page documenting how the
  `vibe-kanban-indie`, `sombrax-telegram`, and `sombrax-codex` plugins from the
  `sombrax_plugins` marketplace link to Indie.

## [0.2.8-beta.6] - 2026-06-17

### Changed

- Version bump.

## [0.2.8-beta.5] - 2026-06-16

### Added

- New "noir-neon" theme.

### Changed

- Logo component updates.

## [0.2.8-beta.4] - 2026-06-15

### Added

- Claude Code Headed support for local workspaces.
- Right-side "New issue" pane.

### Changed

- `scripts/kill-dev-servers.sh` now clears the cached `.dev-ports.json` by
  default so the next `pnpm run dev` re-scans from port 3000 (`--keep-ports`
  preserves the cache).

## [0.2.8-beta.3] - 2026-06-15

i18n maintenance release.

### Fixed

- **Missing `cardPipeline` translations** — added the `agentLabel`,
  `agentDefault`, and `agentHelper` keys to the `es`, `fr`, `ja`, `ko`,
  `zh-Hans`, and `zh-Hant` `common` locales, restoring translation-key
  consistency with `en` and unblocking the `frontend-checks` i18n CI gate.

## [0.2.8-beta.2] - 2026-06-14

Workspace + release-pipeline housekeeping (no runtime changes).

### Changed

- **Cargo workspace version/deps inheritance** — every member now inherits its
  version and edition from `[workspace.package]` (releases are a one-line bump),
  and all dependencies are centralized in `[workspace.dependencies]` with crates
  referencing them via `dep.workspace = true`. Dependency features are merged at
  the workspace level for consistent, cache-friendly incremental builds.
- **Lean prerelease builds** — `release-indie.yml` now picks its build matrix from
  the tag: beta/rc tags build **macOS arm64 only**; stable tags build all 6
  targets.

## [0.2.8-beta.1] - 2026-06-14

First prerelease on the new **beta channel**. Install with
`npx vibe-kanban-indie@beta`.

### Added

- **npm beta/prerelease channel** — `release-indie.yml` now derives the npm
  dist-tag from the version string (`X.Y.Z-<id>.N` → `@<id>`; stable → `@latest`),
  so prereleases publish to `@beta`/`@rc`/`@alpha` without ever clobbering
  `@latest`. Prerelease tags also create GitHub *pre-releases*, keeping the CLI's
  `releases/latest` manifest pointer on the last stable build. See `PUBLISHING.md`.

## [0.2.7] - 2026-06-13

Orchestration release.

### Added

- **Per-card pipelines** — a config-driven stage catalog with New Issue
  checkboxes appended to the card description and an Orchestrate-card hand-off.
- **Orchestrator agent** — a repo-independent singleton headed session that
  drives a card through its pipeline, with an auto-answer `decider` subagent
  that resolves stale agent questionnaires after a two-tick grace.
- **Worktree default folder** and **iTerm tab naming** for headed sessions.

## [0.2.6] - 2026-06-06

A CI hygiene release.

### Removed

- **Upstream BloopAI deploy/release workflows** — the relay/remote
  deploy + release workflows (which dispatched to BloopAI's private deployment
  repo or used BloopAI custom actions), the old `pre-release.yml`/`publish.yml`
  binary+npm pipelines, and the now-orphaned `setup-jsign` action. Two of them
  ran on every push to `main` and failed. This fork's CI is `test.yml` and it
  ships via `release-indie.yml` — neither touches upstream infrastructure.

## [0.2.5] - 2026-06-06

A maintenance release tightening the release process and polishing interactive
sessions.

### Added

- **Interactive terminal tab titles** — headed terminal tabs are now titled with
  the card id + branch so multiple live sessions are easy to tell apart.
- **`make release-check`** — a local mirror of the CI test workflow to run before
  pushing a `v*` tag, since the release workflow publishes without running tests.
- **`agentWorking` status string** — added across all locale bundles.

### Fixed

- Cleaned up the v9 config round-trip test to use struct-update syntax.

## [0.2.4] - 2026-06-05

A follow-up to the Claude Code Headed release: deeper orchestration hooks for
headed sessions, a spec-intake flow, configurable terminal-window grouping, new
CRT theme skins, and in-app Git commit actions.

### Added

- **Generate spec from a brief** — the New Issue flow can expand a short brief
  into a full technical task by running an agent in an ephemeral throwaway
  workspace.
- **Headed questionnaire bridge** — headed agents in plan mode now surface
  `AskUserQuestion` / `ExitPlanMode` prompts to the UI and MCP.
- **CRT / terminal theme variants** — three drop-in "skins" (Navy HUD, Phosphor,
  Amber) applied as a client-side theme axis orthogonal to Light/Dark/System
  (local web only). New skins can be added by dropping a CSS file plus manifest
  entry, no rebuild required.
- Expose Claude Code Headed agent progress and identifiers to the orchestrator
  via MCP, and route MCP headed follow-ups into the live tmux session instead of
  spawning a new agent.
- Accept MCP launcher options (`headed-local-control`, `mode`) as env vars for a
  declarative `.mcp.json`.
- Headed sessions can report to their branch's Telegram channel (VIBE-8).
- Show Claude Code Headed session IDs in the workspace right pane, with a button
  to copy the full `tmux attach` command.
- Group headed iTerm2 sessions as tabs of a single VK-owned window, controlled by
  a new `iterm_tabs` config option (default on, Settings → General → Interactive
  Terminal); turning it off restores one-window-per-session behavior.
- **Commit** action for uncommitted worktree changes, available both in the Git
  toolbar and the per-repo RepoCard git-actions dropdown (shown only when the
  repo has uncommitted changes).
- A product-manager agent.

### Changed

- Updated branding: new logo, restored wordmark/lockup sizing, and the
  feather+wordmark lockup moved beside the left rail in the navbar.
- Reduced the app-wide text scale (root font-size to 87.5%) so rem-based text and
  spacing shrink across the app.

### Fixed

- Suppress noisy "Unrecognized JSON message" log entries for `queue-operation`
  transcript records emitted by headed interactive sessions.

## [0.2.3] - 2026-06-02

The headline is **Claude Code Headed**: a new executor that runs Claude Code in a
real interactive terminal (detached tmux) instead of the headless `-p` stream,
mirrors the live transcript read-only into the timeline, and gives the operator a
full control surface from the web UI.

### Added

- **Claude Code Headed agent** — a new executor type, a thin wrapper over Claude
  Code that the container launches via a detached tmux session with an attached
  terminal viewer.
- Run Claude Code in a spawned terminal via detached tmux (interactive mode).
- Operator control surface for the headed agent: `open-terminal` + `send-input`
  REST endpoints, tmux `send-keys`, and a frontend `InteractiveControlBar`; tmux
  and Claude session IDs are surfaced in the panel header.
- Chat box sends straight to the live agent when it is idle, instead of queueing.
- Tool approvals from a headed session are bridged to the web UI via a `PreToolUse`
  hook, so headed and headless gate the same set of tools.
- Optional Sombrax Telegram channel for headed sessions, with auto-confirmed
  startup (waits 5s before auto-confirming the folder-trust / dev-channel prompts).
- Turn duration shown in seconds for headed turns.
- New **"Default (latest)"** model option that omits `--model` so Claude uses its
  own current default model.
- `vibe-kanban-mcp` is now fully local — the project/issue/org tools no longer call
  the disabled cloud API.
- `Makefile` with an `install` target for `vibe-kanban-mcp`.
- PM intake agent that turns channel requests into vibe-kanban issues.

### Changed

- Pinned Claude Code bumped to 2.1.159 (defaults to Opus 4.8).
- Config: DB restored as the source of truth; TOML is now export/import-only.

### Fixed

- Headed `send-keys` now targets the bare tmux session, not the `=name` form
  (which swallowed input).
- Stop the headed "working" spinner when Claude finishes a turn.
- Canonicalize the transcript cwd; keep the iTerm2 window open.
- Attach the interactive config in both the `start_workspace` and queued-start
  paths.

## [0.2.2] - 2026-05-28

- Migrate to the stable Rust toolchain.
- i18n parity fix for the new Telegram keys.
- Skip backend-remote-checks in CI for the indie fork.

## [0.2.1] - 2026-05-28

- Fix CI toolchain mismatches: pin `sqlx-cli` to 0.8.6, install the pinned
  toolchain explicitly in `release-indie`, and pin `mlugg/setup-zig` to 0.13.0 so
  transient mirror 404s don't break the linux-musl matrix legs.

## [0.2.0] - 2026-05-26

- Local-first **vibe-kanban-indie**: TUI cockpit, Telegram orchestration, and the
  npm release pipeline. First independent, self-hosted (no team, no cloud, no auth)
  release of the fork.

[Unreleased]: https://github.com/dexloom/vibe-kanban-indie/compare/v0.2.8-beta.6...HEAD
[0.2.8-beta.6]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.6
[0.2.8-beta.5]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.5
[0.2.8-beta.4]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.4
[0.2.8-beta.3]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.3
[0.2.8-beta.2]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.2
[0.2.8-beta.1]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8-beta.1
[0.2.7]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.7
[0.2.6]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.6
[0.2.5]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.5
[0.2.4]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.4
[0.2.3]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.3
[0.2.2]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.2
[0.2.1]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.1
[0.2.0]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.0
