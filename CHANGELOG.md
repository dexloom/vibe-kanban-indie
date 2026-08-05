# Changelog

All notable changes to **vibe-kanban-indie** are documented here. This fork is
local-only and single-developer focused; releases are cut by pushing a `v<version>`
tag that matches `npx-cli/package.json` (see `.github/workflows/release-indie.yml`).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.24-beta.1] - 2026-08-05

### Added

- **Two pipeline families, never mixed.** Bundled pipelines now split by
  execution family: `async-claude-{opus,sonnet,fable}` bind Claude Code models
  (Sonnet / Opus / Fable), the new `async-opencode-glm` binds OpenCode models
  (GLM / MiniMax / Kimi), and no pipeline mixes the two. Codex remains the
  shared *reviewer* for both families and is never a build model.
- **`quick.toml`** — the trivial-tier pipeline (implement + merge; no spec, no
  plan, no subagent fan-out), with an inline escalation tripwire for work that
  turns out not to be trivial.
- **Late-binding gates in the Async pipelines.** The plan stage reports a
  `PLAN-FACTS:` line (size / steps / files / open decisions); the Codex plan
  review now runs only when the plan is ≥ 40 KB, carries open decisions, or the
  card's routing forces it (a `PLAN-GATE:` line either way), capped at two
  passes; the coder stage binds its model **within the pipeline's family**
  before delegating (`CODER-MODEL:` line). Measured on real boards, a Codex
  plan review routinely costs more than the plan it reviews, and plan size is
  the strongest predictor of a card blowing up.

### Changed

- **`async-{opus,sonnet,fable}.toml` renamed to `async-claude-*.toml`.**
  Display names are unchanged. A pristine copy of an old file is swept from
  `~/.vibe-kanban/pipelines/` on the next backend start (two shipped versions
  are recognised) so the same pipeline is never listed twice; an edited copy is
  treated as user content and kept.
- The Settings pipeline list now offers **Reset** for every bundled pipeline —
  the `async-*` and `quick` ids were missing from the frontend's bundled set
  even though the server accepted them.
- The bundled OpenCode subagents learned the new board conventions:
  `vk-intake` routes a card to a family + tier and can file dependent/parallel
  **lanes** (`blocking` edges); `vk-sweeper` gates dispatch on those edges,
  takes lighter tiers first, and treats a `VK-ESCALATE:` final message as a
  park.

## [0.2.23] - 2026-07-17

### Fixed

- **Headed sessions no longer 500 on large task prompts.** A headed
  `start_workspace` (Claude Code Headed / OpenCode Headed) packed the entire agent
  invocation — env prefix + flags + the full seed prompt — into `tmux new-session`'s
  single command argument, which tmux ships to its server over a unix socket capped at
  `MAX_IMSGSIZE` (16 KiB). A spec-sized prompt (>16 KiB) tripped tmux's "command too
  long" and surfaced as an HTTP 500. `tmux_new_session` now writes the invocation to a
  self-deleting launch script and hands tmux only the short `sh <path>`; the prompt
  still reaches the agent as its positional seed argument. The non-headed path was
  unaffected (it `execve`s the argv directly).

## [0.2.22] - 2026-07-17

### Added

- **OpenCode Headed agent type — an alternative to Claude Code Headed.** A new
  `OPENCODE_HEADED` executor runs the opencode TUI inside a detached tmux session
  (mirroring the `ClaudeCodeHeaded` pattern), so a solo dev can drive the board with
  opencode instead of Claude Code. Includes the full agent-type plumbing (enum
  variant, profile, generated TS types/schema, UI icon), a dedicated
  `start_detached_tmux_opencode` launch path (free embedded-server port, `--prompt`/
  `-c` resume, `autoupdate:false` to suppress the update modal, permission/compaction
  env), generalized `BaseCodingAgent::is_headed()` detection across all sites, and
  lifecycle-only tracking. The orchestrator executor is now parameterized
  (`SpawnOrchestratorRequest.executor`) so it can later run on OpenCode; the Claude
  backend stays the default. Bundled in-repo opencode subagents
  (`vk-sweeper`/`vk-decider`/`vk-intake`) are seeded into the opencode config when
  opencode is already installed. Full output mirroring via the TUI's embedded server
  is the remaining follow-up for an OpenCode orchestrator.

## [0.2.21] - 2026-07-16

## [0.2.20] - 2026-07-16

### Fixed

- **Starting the Orchestrator no longer errors trying to spawn the retired
  `sweeper` agent.** The `vibe-kanban-indie` plugin replaced the orchestrator/sweeper
  split with a single-loop orchestrator and removed the `sweeper` agent, but the app
  still composed a default-agent loop-manager brief whose first tick step was to
  spawn `vibe-kanban-indie:sweeper` — failing with `Agent type 'sweeper' not found`.
  The app now launches the orchestrator as the plugin's own session agent
  (`--agent vibe-kanban-indie:orchestrator`) with the plugin's short per-tick
  pointer as the `/loop` body; every remaining `sweeper` reference in source, docs,
  and comments is gone. The opt-in directives block is unchanged.

## [0.2.19] - 2026-07-16

## [0.2.18] - 2026-07-15

### Fixed

- **The orchestrator can now spawn its sweeper when started from the app.** It is
  launched as the default Claude session instead of
  `--agent vibe-kanban-indie:orchestrator`. Selecting a plugin agent as the
  top-level session agent left the plugin's sibling agents
  (`sweeper` / `decider` / `intake`) unregistered as spawnable subagent types, so
  every tick failed at the sweep step with `Agent type 'sweeper' not found` (and
  `--plugin-dir` did not fix it). The default agent registers every enabled
  plugin's agents, so those siblings resolve; the loop-manager behaviour now
  travels in the self-contained `/loop` brief the app composes rather than in the
  plugin's `orchestrator` agent definition.

## [0.2.17] - 2026-07-14

### Added

- **Async Opus bundled pipeline.** A third Async pipeline: Opus subagents write
  the spec and the plan, a Sonnet subagent writes the code, and Codex reviews
  both the plan and the diff. It seeds automatically into existing installs and
  lists between SpecKit and Async Sonnet.

### Changed

- **The three Async pipelines now default to Merge to base on and Review via
  Codex off.** Their merge stage tells the agent to squash-merge the card's
  branch into its base itself — the stage being listed is the authorisation, so
  it does not wait for a go-ahead. Add a **Wait for approval** stage when you
  want the pipeline to pause for you.
- **`get_execution` MCP response slimmed.** Prompt strings in the execution
  payload (including nested `next_action` chains and legacy untagged JSON) are
  now head-truncated, so status polls stop re-sending the full coding-agent
  prompt (measured 73% smaller on a real execution). `run_session_prompt` is
  unaffected and still returns the full payload.
- **`update_issue` MCP response minimised.** The tool now returns a flat ack
  (id, simple_id, status, status_id, updated_at, changed fields) instead of
  echoing the full card back — a changed description reports only its
  character count. Callers needing the body call `get_issue`. Also drops the
  post-PATCH detail fan-out, cutting a status-only update from ~8 HTTP
  requests to 3.
- **Bundled pipeline seeds synced with the live pipelines.** The Basic,
  SpecKit, WikiLLM, and Async trio seeds in `assets/pipelines/` now carry the
  same spec/plan-prompt and squash-merge-stage fixes as the operator-local
  copies, so a Settings Reset or fresh install no longer hands out stale
  prompts.
- **Basic pipeline's merge stage is now a CAS-safe squash auto-merge**,
  enabled by default. It squash-merges the card's branch into its base with a
  compare-and-swap `update-ref`, verifies with monotonic ancestry
  (`git merge-base --is-ancestor`) rather than tip equality, and resolves
  rebase conflicts via `git add` + `git rebase --continue`.

### Removed

- **Retired-`async.toml` auto-removal.** The preserved copies of the old bundled
  `async.toml` (retired in 0.2.14 in favour of Async Sonnet and Async Fable) have
  been dropped, so a pristine `async.toml` left in `~/.vibe-kanban/pipelines/` is
  no longer removed for you on start-up — delete it from the Settings pipeline
  list if you still have one. The retirement mechanism itself is unchanged and
  stays available for future bundled-pipeline retirements.

### Fixed

- **MCP `update_issue` with `parent_issue_id: null` now un-nests the issue.**
  A JSON `null` previously collapsed to the same "not provided" state as an
  omitted field, so sending it silently no-op'd instead of clearing the
  parent. Clients that were sending `null` as a lazy "leave it alone" should
  now omit the field instead.

## [0.2.16] - 2026-07-11

## [0.2.15] - 2026-07-10

## [0.2.15-beta.2] - 2026-07-10

### Fixed

- **CI: pin npm to the 11.x line for publishing.** npm@12.0.0 crashes during
  `npm publish` (`MODULE_NOT_FOUND: sigstore` in its bundled `libnpmpublish`
  when OIDC trusted publishing attaches provenance), which killed the
  v0.2.15-beta.1 npm publish after everything else in the release succeeded.

## [0.2.15-beta.1] - 2026-07-10

### Fixed

- **CI: release npm publish and clippy failures.** The `publish-npm` job now
  runs on Node 24 (`npm@latest` moved to npm 12, which requires Node ≥ 22 — the
  v0.2.14 npm publish failed on this, so v0.2.14 shipped as a GitHub release
  only). Removed redundant struct-field wildcard patterns in
  `crates/executors/src/executors/codex/normalize_logs.rs` that the newer
  stable clippy on CI runners rejects.

## [0.2.14] - 2026-07-10

### Changed

- **Async pipeline split into Async Sonnet and Async Fable.** The bundled
  `async.toml` is retired and replaced by `async-sonnet.toml` (Sonnet subagents
  spec, plan, and code) and `async-fable.toml` (Fable subagents spec and plan —
  marked `heavy` — and an Opus subagent codes). In both pipelines the plan
  review and code review are Codex-only; the separate "Review via Fable
  subagent" stage is removed.
- **Bundled pipelines now reach existing installs.** Seeding tracks bundled
  files in `~/.vibe-kanban/pipelines/.seed-manifest.json`: newly bundled
  pipelines are seeded exactly once into existing installs, user edits and
  deletions stay sticky, and a retired bundled file (e.g. the old `async.toml`)
  is auto-removed only when it byte-matches a previously shipped version.
  Fixes stale local pipelines never receiving updates (e.g. the missing
  `heavy` badge from VIBE-3).

## [0.2.13] - 2026-07-03

## [0.2.12] - 2026-07-03

## [0.2.11] - 2026-07-02

### Added

- **Async pipeline** — a fourth bundled pipeline (`async.toml`) built around
  subagent fan-out: an Opus main loop specs and plans, then spawns the
  `vibe-kanban-indie:coder` subagent (Sonnet) to implement from `SPEC.md` +
  `IMPLEMENTATION_PLAN.md`, and runs a Fable review subagent alongside a Codex
  review before merge/PR.

## [0.2.10] - 2026-07-02

### Changed

- **File-based pipelines.** Pipelines are now first-class, user-editable TOML
  files in `~/.vibe-kanban/pipelines/` (bundled defaults `basic`, `wikillm`,
  `speckit`, `async`, seeded on first run). The New Issue "Pipeline" control lets you pick
  a pipeline and tick which of its stages to run; vibe-kanban composes an
  **ordered, numbered** `## Pipeline` block that the execution agent runs
  top-to-bottom (no more agent-side stage selection). Settings → Pipeline now
  edits the pipeline files (raw TOML) with per-file and global reset. Managed via
  a new `/api/pipelines` API. The old in-config `pipeline_steps` catalog is
  deprecated and ignored (retained for config back-compat). The separate SpecKit
  workbench engine is unchanged.

## [0.2.9] - 2026-07-01

### Added

- **SpecKit (Spec-Driven Development) workbench** — a per-feature workbench with
  constitution, specify, clarify, plan, tasks, analyze, and implement stages,
  plus matching SpecKit pipeline steps in the New Issue Pipeline catalog.
- **Recall / Enrich knowledge-base pipeline steps** — "Recall prior knowledge"
  (distill relevant project knowledge into `PRIOR_KNOWLEDGE.md` before planning)
  and "Enrich knowledge base" (record reusable knowledge from what shipped).
- **Native SwiftUI macOS app** (`apps/macos`) — a native VibeKanban desktop
  shell that embeds the backend.

## [0.2.8] - 2026-06-19

First stable release on the `0.2.8` line — promotes the `0.2.8-beta` series to
`@latest`.

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

[Unreleased]: https://github.com/dexloom/vibe-kanban-indie/compare/v0.2.8...HEAD
[0.2.8]: https://github.com/dexloom/vibe-kanban-indie/releases/tag/v0.2.8
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
