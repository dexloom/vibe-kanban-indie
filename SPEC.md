# SPEC — File-based Pipelines (rethink pipelines)

## Problem statement

Today a "pipeline" is **not a first-class entity**. It is:

1. A single flat catalog of independent steps, hardcoded in Rust —
   `default_pipeline_steps()` in
   `crates/services/src/services/config/mod.rs:78-231` — optionally overridden
   wholesale by `Config.pipeline_steps` (`config/versions/v9.rs:103-106`) and
   edited in **Settings → Pipeline**.
2. A per-card checkbox control (New Issue dialog) that ticks a subset of those
   steps and glues their `prompt_fragment`s into a `## Pipeline` markdown block,
   delimited by `<!-- vk:pipeline:start -->` / `<!-- vk:pipeline:end -->`, which
   is appended to the card description
   (`packages/web-core/src/shared/lib/pipeline/cardPipeline.ts`,
   `pages/kanban/PipelineSection.tsx`).
3. **Agent-side interpretation**: the execution agent reads that whole block and
   *decides for itself* which bullets to run, "matching by intent", because the
   real pipeline logic lives in plugin prose
   (`sombrax_plugins/external_plugins/vibe-kanban-indie/prompts/pipeline.md`,
   `.../CLAUDE.md`). Nothing enforces order or completion.

Consequences we want to fix:

- There is no named "Basic" / "WikiLLM" / "SpecKit" pipeline the operator can
  pick — only one undifferentiated checkbox list mixing all three flavours
  (classic dev steps, knowledge-base steps, and SpecKit steps) in one pane.
- Pipelines are not user-authorable: adding or tweaking a pipeline means editing
  Rust and shipping a build, or hand-editing an opaque config blob.
- The pipeline "brain" is smeared across agent prompts. The agent both *decides*
  and *executes*, so behaviour drifts with prompt wording and is hard to reason
  about.

## Goals

1. **Pipelines become first-class, file-based entities.** Each pipeline is one
   TOML file. Users can add, edit, or remove pipeline files to define their own
   pipelines without touching code.
2. **Split today's flat catalog into three shipped pipeline files**: `basic`,
   `wikillm`, `speckit` — each self-contained.
3. **Redesign the per-card UI**: the operator first **picks one pipeline**, then
   **ticks which of that pipeline's stages** to enable (the "pipeline options"),
   then optionally edits the composed block — instead of one giant flat list.
4. **Move pipeline-driving off the agent prompt and onto the vibe-kanban side.**
   vibe-kanban composes an **explicitly ordered** stage list from the chosen
   pipeline file into the card block; the agent executes it **in order,
   top-to-bottom, without self-selecting or intent-matching**. The per-stage
   "what to do" lives in the pipeline files, not in agent prompts. Agent prompts
   are trimmed to a thin executor role.
5. **Redesign Settings → Pipeline** to manage pipeline *files* (discover, view
   stages, edit raw TOML, reset to bundled defaults) instead of editing a flat
   in-config step array.

## Non-goals / out of scope

- **The separate SpecKit stage engine / workbench stays untouched.** The
  interactive SpecKit workbench (`crates/api-types/src/speckit.rs`,
  `crates/services/src/services/speckit/`, `crates/server/src/routes/speckit.rs`)
  is a parallel system and is *not* refactored here. Only the card-pipeline
  `speckit-*` steps that currently live in the flat catalog move into a
  `speckit.toml` pipeline file.
- **No server-side per-stage execution/tracking.** Per the chosen execution
  model, vibe-kanban composes an ordered prompt; it does **not** run a stage
  state machine, dispatch one agent per stage, or verify stage completion
  server-side. (Noted as possible future work.)
- **No new DB table.** Per-card pipeline data continues to live in the card
  description block + `extension_metadata.pipeline` provenance, exactly as today.
- **Per-repo pipeline files** (versioned inside each project) are **future
  work**. This card ships **host-global** pipeline files only. See Open
  questions.
- **Multi-pipeline composition** (enabling several pipeline files at once for one
  card) is future work; a card selects exactly one pipeline.

## Design overview

### 1. Pipeline files (new source of truth)

- **Location:** `~/.vibe-kanban/pipelines/*.toml` — the fork's persistent home
  dir resolved by `utils::path::get_vibe_kanban_home_dir()` (the same
  `~/.vibe-kanban` convention as `telegram.toml` / `projects.toml` / `worktrees`;
  debug builds use `~/.vibe-kanban-dev/`). This is **not** the platform
  app-data/`asset_dir()` that holds `config.json`.
- **Format (TOML):**

  ```toml
  # basic.toml
  name = "Basic"
  description = "Classic spec → plan → implement → review dev flow."

  [[stage]]
  id = "spec"
  label = "Create spec"
  default_enabled = true
  prompt = "Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing."

  [[stage]]
  id = "plan"
  label = "Create plan"
  default_enabled = true
  prompt = "Write a step-by-step implementation plan and save it to `IMPLEMENTATION_PLAN.md` at the repo root."
  # ... more stages
  ```

  A `[[stage]]` maps 1:1 to today's `PipelineStep`
  (`id` / `label` / `prompt` (was `prompt_fragment`) / `default_enabled`).
  Stages are ordered by their position in the file (this order is authoritative
  for the composed block).

- **Pipeline identity:** the file stem is the pipeline `id` (e.g. `basic`);
  `name` is the display name. Files with duplicate/invalid content are skipped
  with a logged warning (never crash the app; a bad user file must not brick the
  New Issue dialog).

- **Bundled defaults:** `basic.toml`, `wikillm.toml`, `speckit.toml` are shipped
  embedded in the binary and **seeded to disk on first run** (only when the
  `pipelines/` dir is absent/empty), so users get working pipelines out of the
  box and can then edit them. A **"Reset to defaults"** action re-writes the
  bundled files.

#### Shipped pipeline contents (derived by splitting today's catalog)

- **`basic.toml`** — classic dev flow: `orchestrate`, `spec`, `plan`,
  `plan-review`, `wait-for-approval`, `code-review`, `update-docs`, `merge`,
  `pr`. (Sensible defaults on: `spec`, `plan`, `code-review`.)
- **`wikillm.toml`** — knowledge-augmented flow: `basic` stages **plus**
  `recall-knowledge` (before plan) and `enrich-knowledge` (after implement),
  interleaved in order. (Knowledge-base pipeline.)
- **`speckit.toml`** — spec-driven flow: `orchestrate`, `speckit-constitution`,
  `speckit-specify`, `speckit-clarify`, `speckit-plan`, `speckit-tasks`,
  `speckit-analyze`, `speckit-implement`, `code-review`, `merge`. Each stage's
  prompt runs the matching `/speckit.*` slash command (verbatim from today's
  fragments). This drives a SpecKit card via the ordinary card pipeline; it does
  **not** touch the SpecKit workbench engine.

All `prompt` strings are carried over verbatim from `default_pipeline_steps()`
so agent behaviour for existing stages is unchanged; only *where the text lives*
and *how it is ordered/enforced* changes.

### 2. Backend

- **New api-type `Pipeline`** (in `crates/api-types`): `{ id: String, name:
  String, description: Option<String>, stages: Vec<PipelineStep> }`.
  `PipelineStep` is reused; its field `prompt_fragment` is retained in the Rust
  struct (rename optional — see Implementation Plan) and populated from the TOML
  `prompt` key.
- **New loader service** (in `crates/services`, e.g.
  `services/pipelines/mod.rs`): resolves `<config-dir>/pipelines/`, seeds bundled
  defaults if empty, reads and parses every `*.toml` into `Vec<Pipeline>`
  (sorted, e.g. bundled order first then alphabetical), returning a typed result
  with per-file errors surfaced as warnings.
- **New HTTP routes** under `/api/pipelines`:
  - `GET /api/pipelines` → `Vec<Pipeline>` (all discovered pipelines with their
    stages) — feeds the New Issue picker.
  - `GET /api/pipelines/{id}/raw` → raw TOML string (for the Settings editor).
  - `PUT /api/pipelines/{id}/raw` → write raw TOML back to disk (validated:
    reject content that fails to parse).
  - `POST /api/pipelines/reset-defaults` → re-seed bundled files.
  - (`DELETE /api/pipelines/{id}` optional — Settings "remove".)
  Registered alongside existing config routes in the main router.
- **Deprecate the in-config catalog.** `Config.pipeline_steps` and
  `default_pipeline_steps()`/`DEFAULT_PIPELINE_STEPS` are replaced by the file
  loader. The `pipeline_steps` field is retained as deprecated/ignored for config
  back-compat (no config migration break) but is no longer read by the UI.

### 3. Frontend

- **New Issue dialog `PipelineSection`** redesign:
  1. Fetch `GET /api/pipelines`.
  2. **Pipeline picker** (`<select>`): choose one pipeline (default: `basic`, or
     first discovered if `basic` absent). "None" is allowed (no pipeline block).
  3. **Stage checkboxes** for the chosen pipeline's stages, seeded from each
     stage's `default_enabled`, in file order.
  4. Execution-agent `<select>` and editable composed-block textarea: unchanged
     behaviour.
  5. Emits `PipelineSelection` extended with `pipelineId`.
- **Composed block** (`cardPipeline.ts`): stages render as an **ordered list**
  under a `## Pipeline` heading naming the pipeline, e.g.

  ```
  <!-- vk:pipeline:start -->
  ## Pipeline: Basic

  Execute these stages in the order listed. Do not add, skip, or reorder stages.

  - Run this card with the **CODEX** execution agent: ...
  1. Write a technical spec ... `SPEC.md` ...
  2. Write a step-by-step implementation plan ... `IMPLEMENTATION_PLAN.md` ...
  3. After implementing, run a code review ...
  <!-- vk:pipeline:end -->
  ```

  The `vk:pipeline` delimiters, the executor-pin line format
  (`composeExecutorLine`), and the `orchestrate`/`wait-for-approval` conventions
  are **preserved** so the orchestrator's existing parsing keeps working
  (`agents/orchestrator.md` executor + Orchestrate opt-in + `AWAITING OPERATOR
  APPROVAL` park marker are unaffected).
- **`extension_metadata.pipeline`** provenance gains `pipelineId` alongside
  `enabledIds` / `executor` / `customText`.
- **Settings → Pipeline** redesign: list discovered pipelines (name, id, stage
  count); expand one to view/edit its raw TOML in a textarea with Save
  (validated) and per-pipeline reset; a global "Reset all to defaults" button.
  Replaces the flat add/remove-step editor.

### 4. Agent prompts (thin executor)

Move pipeline knowledge out of prompts into the files, and make the agent obey
the ordered block instead of choosing:

- `sombrax_plugins/external_plugins/vibe-kanban-indie/prompts/pipeline.md`:
  replace "the block lists *optional* stages; you decide which apply / match by
  intent" with "**Execute the numbered stages in the card's `## Pipeline` block
  in the exact order given; do not add, skip, or reorder them.**" Keep the
  per-stage *HOW* (delegate spec→`product`, plan→`planner`, reviews→`codex`), but
  drop the per-stage *WHAT/whether* (that now comes from the block text).
- `.../CLAUDE.md`: keep the canonical conventions the orchestrator still relies on
  (stage ordering reference, `AWAITING OPERATOR APPROVAL` marker, executor-pin
  line), but reframe the pipeline as "authored by vibe-kanban from a pipeline
  file and delivered pre-ordered in the block" rather than "the agent selects
  points to follow".
- No change to `orchestrator.md` parsing contracts (delimiters, executor line,
  opt-in sentence, park marker all preserved).

## Acceptance criteria

1. `~/.vibe-kanban/pipelines/` is auto-seeded on first run with `basic.toml`,
   `wikillm.toml`, `speckit.toml`; editing/adding a `*.toml` file and reloading
   makes it appear as a selectable pipeline with no rebuild.
2. `GET /api/pipelines` returns the three shipped pipelines with correct stages
   and order; a malformed user TOML file is skipped (warning logged) without
   breaking the endpoint.
3. New Issue dialog: selecting a pipeline shows only that pipeline's stages;
   ticking stages + choosing an agent produces a `## Pipeline` block with an
   **ordered** stage list, the pipeline name in the heading, the executor-pin
   line, and the preserved `vk:pipeline` delimiters. The block is appended to the
   description and provenance (incl. `pipelineId`) is mirrored to
   `extension_metadata.pipeline`.
4. Settings → Pipeline lists the pipeline files, can edit+save raw TOML (invalid
   TOML is rejected with an error, not silently saved), and can reset to bundled
   defaults.
5. Agent prompts instruct the execution agent to run the block's stages **in
   order without self-selection**; the plugin prose no longer describes the full
   pipeline catalog as the agent's decision surface. Orchestrator parsing
   (executor pin, Orchestrate opt-in, approval park marker) still works.
6. Existing stage prompt text (spec/plan/etc.) is byte-for-byte preserved in the
   shipped files, so a card built from `basic` behaves as it does today (minus
   agent self-selection).
7. `pnpm run check`, `pnpm run lint`, `cargo test --workspace`, and
   `pnpm run generate-types:check` pass; `pnpm run format` applied. New i18n keys
   added across all locales (avoid the key-consistency CI gate).

## Risks / mitigations

- **CI i18n key-consistency gate** (the VIBE-18 failure): any new `en` strings
  must be mirrored to all 6 non-`en` locales. — Add all keys to every locale.
- **A bad user pipeline file bricking card creation.** — Loader must isolate
  per-file parse errors and always return the valid ones.
- **Orchestrator contract drift.** — Keep delimiters, executor-pin format,
  Orchestrate opt-in sentence, and `AWAITING OPERATOR APPROVAL` marker exactly;
  add regression coverage where practical.
- **Config back-compat.** — Retain (ignore) `Config.pipeline_steps` so old
  configs still load; don't force a schema version bump unless required.

## Open questions (defaults chosen unless you say otherwise)

1. **Global vs per-repo files.** Chosen: **host-global**
   `~/.vibe-kanban/pipelines/`. Per-repo overlay is future work.
2. **File format.** Chosen: **TOML** (1:1 with `PipelineStep`, clean multi-line
   prompts). Markdown-with-frontmatter was the alternative.
3. **In-app TOML editing depth.** Chosen: raw-TOML edit + reset in Settings
   (source of truth is the files). A structured per-stage form editor is future
   work.
4. **Default selected pipeline** in the New Issue dialog: chosen **`basic`** (or
   first discovered if `basic` absent).
