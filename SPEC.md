# SPEC — i18n fix: translate the 41 missing locale keys (VIBE-18)

## Problem statement

The release CI job `.github/workflows/test.yml` runs
`vibe-kanban/scripts/check-i18n.sh`, which fails (exit 1) at the
`check_key_consistency` stage. That function treats
`packages/web-core/src/i18n/locales/en/*.json` as the source of truth and fails
if any non-`en` locale is missing a key that exists in `en`.

**Root cause.** Two indie-fork features — **Card Pipeline** and **Spawn
Orchestrator** — added new strings to the `en` locale only. The translations for
the other 6 locales were never added. Each of the 6 non-`en` locales is missing
the **same 41 keys**, so the key-consistency gate trips on every release.

- Locales: `en` (source) + `es`, `fr`, `ja`, `ko`, `zh-Hans`, `zh-Hant`.
- Namespaces with gaps: `common` (6), `settings` (19), `tasks` (16). `organization`
  and `projects` are already consistent.
- 41 missing keys × 6 locales = **246 string values** to add.

## The 41 missing keys (exact paths, from `en`)

### `common.json` — `cardPipeline.*` (6) — Card Pipeline feature
```
cardPipeline.title
cardPipeline.description
cardPipeline.noSteps
cardPipeline.addonLabel
cardPipeline.addonPlaceholder
cardPipeline.resetToCheckboxes
```

### `settings.json` (19) — Card Pipeline feature
Nested under the top-level `settings` wrapper. Two nav entries + the pipeline
settings panel:
```
settings.layout.nav.pipeline
settings.layout.nav.pipelineDesc
settings.pipeline.loading
settings.pipeline.loadError
settings.pipeline.save.success
settings.pipeline.save.error
settings.pipeline.steps.title
settings.pipeline.steps.description
settings.pipeline.steps.reset
settings.pipeline.steps.empty
settings.pipeline.steps.customize.label
settings.pipeline.steps.customize.helper
settings.pipeline.steps.fields.label
settings.pipeline.steps.fields.labelPlaceholder
settings.pipeline.steps.fields.prompt
settings.pipeline.steps.fields.promptPlaceholder
settings.pipeline.steps.fields.defaultEnabled
settings.pipeline.steps.actions.add
settings.pipeline.steps.actions.remove
```

### `tasks.json` — `spawnOrchestrator.*` (16) — Spawn Orchestrator feature
```
spawnOrchestrator.title
spawnOrchestrator.description
spawnOrchestrator.nameLabel
spawnOrchestrator.directivesLabel
spawnOrchestrator.existingRunning
spawnOrchestrator.openRunning
spawnOrchestrator.close
spawnOrchestrator.closing
spawnOrchestrator.spawning
spawnOrchestrator.spawn
spawnOrchestrator.options.auto-unblock.label
spawnOrchestrator.options.auto-unblock.description
spawnOrchestrator.options.auto-answer-questions.label
spawnOrchestrator.options.auto-answer-questions.description
spawnOrchestrator.options.telegram-fanout.label
spawnOrchestrator.options.telegram-fanout.description
```

The authoritative `en` source values for all 41 keys live in:
- `packages/web-core/src/i18n/locales/en/common.json` (the `cardPipeline` block)
- `packages/web-core/src/i18n/locales/en/settings.json` (`settings.layout.nav.pipeline`/`pipelineDesc` and the `settings.pipeline` block)
- `packages/web-core/src/i18n/locales/en/tasks.json` (the `spawnOrchestrator` block)

## Scope

- Add the 41 missing keys, **properly translated**, to each of the 6 non-`en`
  locale directories (`es`, `fr`, `ja`, `ko`, `zh-Hans`, `zh-Hant`).
- Preserve **the exact key structure / nesting / paths** as `en` — same parent
  objects, same key names, only the string values are localized.
- Insert the new blocks in a sensible position (e.g. mirroring `en`'s ordering) —
  ordering doesn't affect the check, but keep diffs reviewable.

## Out of scope

- No changes to any `en` file.
- No changes to `scripts/check-i18n.sh` or `.github/workflows/test.yml`.
- No new languages/locales.
- No retranslation of existing (already-consistent) keys.
- No code changes (no `.ts`/`.tsx`); therefore no new
  `i18next/no-literal-string` lint violations can be introduced.
- No changes to `organization` or `projects` namespaces (already consistent).

## Translation guidance

- Translations must be **natural and idiomatic** per language, matching the tone
  and conventions already used in that locale's existing files.
- Handle product/technical terms per each locale's existing convention (be
  consistent with how the rest of that locale already renders them):
  - **Pipeline**, **Orchestrator** — typically kept as loanwords or rendered with
    the established term used elsewhere in that locale; for CJK locales follow the
    convention already used in the file (loanword vs. translated term).
  - **MCP**, **Telegram**, **Claude Code** — proper nouns / acronyms; keep
    verbatim in all locales.
  - "New Issue", "Settings → Pipeline", "Settings → Pipeline control" — translate
    the surrounding prose but keep references aligned with how those UI labels are
    already translated in that locale (so the breadcrumb points at a real label).

## Risks / notes

- **Preserve interpolation tokens and glyphs.** Several source values carry
  literal characters that must survive translation unchanged:
  - Ellipsis `…` (e.g. `settings.pipeline.loading` = "Loading pipeline settings…").
  - Checkmark `✓` (e.g. `settings.pipeline.save.success` = "✓ Settings saved
    successfully!").
  - Keep any `{{token}}` interpolation placeholders byte-for-byte if present in a
    value (the listed 41 keys are mostly static, but verify against the live `en`
    values before translating).
- **No extra keys.** Do not introduce keys absent from `en` — the check warns on
  extras by default and the spec forbids them. Add exactly the 41, nothing more.
- **No duplicate keys.** `check_duplicate_json_keys` fails the build on any
  duplicated JSON key within a file; ensure each added key appears once.
- **Valid JSON.** Files must remain parseable by `jq` (used by the check) — no
  trailing commas, correct quoting/escaping.
- The `settings` namespace keys sit under a **top-level `settings` wrapper object**
  (so paths are `settings.pipeline.*`, not `pipeline.*`). Place the new blocks
  inside the existing `settings` object in each locale's `settings.json`.

## Acceptance criteria

1. Running `vibe-kanban/scripts/check-i18n.sh` reports
   **"✅ Translation keys are consistent across locales."** — no `❌ Missing keys`
   for any locale/namespace.
2. **"✅ No duplicate keys found in JSON files."** — no duplicate-key failures.
3. No **extra** keys (keys not present in `en`) introduced in any locale (no
   `⚠️`/`❌` extra-keys lines for the touched files).
4. Every touched JSON file is valid and its key structure/nesting matches the
   corresponding `en` file exactly (same paths for all 41 keys).
5. The literal-string lint count is unchanged (no `.ts`/`.tsx` edited), so the
   `no-literal-string` portion of the script does not regress.
6. Each of the 6 non-`en` locales now contains all 41 keys with locale-appropriate,
   idiomatic translations; placeholders/ellipses/checkmark glyphs preserved.
7. No changes to `en` files, the check script, or the workflow.

## Verification

From `vibe-kanban/`:
```
bash scripts/check-i18n.sh
```
Expect the consistency and duplicate-key sections to pass. (The script also clones
the base branch to diff literal-string counts; since no `.ts`/`.tsx` changed, that
count must not increase.)
