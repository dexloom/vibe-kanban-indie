# SpecKit workbench ↔ pipeline convergence (VIBE-48)

## The drift this fixes

Two SpecKit implementations shipped in parallel:

1. **SpecKit workbench engine** (`crates/services/src/services/speckit/mod.rs`,
   `crates/server/src/routes/speckit.rs`, `packages/web-core/src/pages/speckit/*`) —
   `POST /speckit/feature` created a **dedicated persistent workspace** on a minted
   `NNN-slug` branch, provisioned the `.specify/` scaffold, and `run_stage` **drove
   stages itself** via a one-shot coding agent. Artifacts lived under
   `specs/NNN-slug/`.
2. **SpecKit pipeline** (`assets/pipelines/speckit.toml`) — stage prompts appended to
   the card description; the card's **own execution agent** ran `/speckit.*`,
   writing `specs/<current branch>/` inside the **card's own issue-linked
   workspace**.

That's two workspaces per issue, two feature-dir conventions, two drivers, and a
latent bug: the vendored `.specify/` + `.claude/commands/speckit.*.md` scaffold was
only ever written by the workbench's `create_feature`, so a pipeline-driven card's
workspace never got it — the pipeline's `/speckit.*` invocations had no command
files to run.

## Decision: workbench-as-viewer

- **One file layout**: `specs/<workspace-branch>/` inside the card's single
  issue-linked workspace, written by the `/speckit.*` slash commands.
  `speckit::feature_dir` is a **pure function of the workspace's git branch** — the
  one rule that reconciles `specs/NNN-slug/` and `specs/<card-branch>/`.
- **One driver**: the card's execution agent (the pipeline). The workbench stops
  creating a workspace and stops driving stages; it is a **read/edit viewer** of the
  pipeline's artifacts on disk, resolving the workspace via the `issue_workspaces`
  link (`IssueWorkspace::find_latest_by_issue`, ordered by the **workspace's**
  `created_at` since link rows go stale on relink).
- **One source of stage state**: artifacts on disk. There was never server-side
  per-stage state; `computeStageState` (frontend) stays the single derivation, now
  fed by the pipeline's artifacts.
- **Scaffold moves to the pipeline path, pre-agent**: provisioned inside
  `ContainerService::start_workspace`, after `self.create()` (worktrees
  materialized) and before the coding agent spawns, guarded by
  `speckit::is_speckit_pipeline(&prompt)`. This is the single chokepoint every
  start flow (web `create_and_start_workspace`, MCP `start_workspace`, TUI) passes
  through, so the scaffold is guaranteed present before the pipeline's `/speckit.*`
  run — unlike `link_workspace`, which happens *after* the agent has already
  started.

## The working-directory contract (the single anchor)

The scaffold, the agent, and the viewer must all agree on one base directory. That
base is the agent's **effective working directory**, computed by
`Session::resolve_agent_working_dir(pool, workspace_id)` and joined onto
`container_ref`:

- **single repo, no `default_working_dir`** → `container_ref/<repo>`
- **single repo with `default_working_dir` subdir** → `container_ref/<repo>/<subdir>`
- **multi-repo** (resolver returns `None`) → `container_ref` (workspace root)

Because the executor spawns the agent at exactly
`container_ref.join(agent_working_dir)` (`coding_agent_initial.rs::effective_dir`),
anchoring on this same value guarantees: `.claude/commands/speckit.*.md` is
discovered at the agent cwd, `/speckit.*` writes `specs/<current git branch>/`
under the agent cwd (`git` still reports the worktree branch from any subdir), and
the viewer reads `<base>/specs/<branch>` + `<base>/.specify/memory/constitution.md`.
For **single-repo** workspaces (with or without `default_working_dir`) all three
use the identical base and the layout is fully reconciled.
`Session::resolve_agent_working_dir` is `pub` specifically so both the
scaffold-provisioning path and the viewer route reuse it instead of
re-deriving it.

**Multi-repo workspaces are an explicit non-goal for SpecKit** (the card scopes
SpecKit to the feature's primary repo). In multi-repo the agent cwd is the
workspace root, which is not a git worktree, so `/speckit.*`'s "current git
branch" derivation is undefined. Rather than silently render wrong data, SpecKit
is **gated to single-repo**: the viewer treats a workspace with `repos.len() != 1`
as "not applicable" (a clear notice, not artifacts), and scaffold provisioning
skips it.

## What went away

`create_feature`, `run_stage`, `SpecKitMeta`, `feature_slug`, `stage_prompt`,
`RunStageRequest/Response`, `CreateSpecKitFeatureRequest/Response`, and the
frontend setup+run+polling machinery. The workbench already read every artifact
off disk (`get_artifacts`, `get_tasks`, `get_constitution` all `std::fs::read`),
so becoming a pure viewer required no fallback plan — just deleting the driver
half.
