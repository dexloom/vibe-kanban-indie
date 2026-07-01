# SPEC — Remove the Changelog / "What's New" release-notes announcement from the UI

## Problem statement

When a new version of vibe-kanban-indie is installed, the app pops a
**"What's New"** modal (the release-notes / changelog announcement). For this
fork the modal shows up **empty** — a dialog titled "What's New" with no
changelog content.

### Root cause

The announcement is driven by three cooperating pieces:

1. **Backend trigger** — on startup, `crates/local-deployment/src/lib.rs`
   compares the running `APP_VERSION` against the persisted `last_app_version`
   in config. On any change (and only when a previous version was stored, i.e. an
   upgrade, not a first install) it sets `raw_config.show_release_notes = true`.

2. **Frontend gate** — `ReleaseNotesHandler` in
   `packages/local-web/src/routes/_app.tsx` reads `config.show_release_notes`;
   when true it opens `ReleaseNotesDialog`, then flips the flag back to `false`.

3. **Dialog content** — `ReleaseNotesDialog`
   (`packages/web-core/src/shared/dialogs/global/ReleaseNotesDialog.tsx`) calls
   the `useReleases()` hook → `GET /api/releases`
   (`crates/server/src/routes/releases.rs`), which proxies the GitHub Releases
   API for `dexloom/vibe-kanban-indie`, filtering out prereleases and
   `remote-`/`relay-` tags.

The GitHub API **does** return stable releases for the fork (v0.2.9, v0.2.8,
v0.2.7, v0.2.6, v0.2.2, v0.2.1), **but every release body is empty**
(`body === ""`). The dialog renders each release's version + date header, and
because it guards note rendering with `release.body && (…)`, no note text is
ever shown. The result is a "What's New" dialog with version numbers but no
changelog — an empty announcement.

### Why remove instead of "fix"

Making the announcement non-empty would require **authoring release-note bodies
on GitHub** for each published release — a release-process / infrastructure task,
not a code change. The card explicitly asks to "fix or remove … if you cannot
fix." Since the emptiness cannot be fixed in code, the correct action is to
**remove the changelog announcement from the UI**, along with the now-unused
plumbing that fed it.

## Goal

Remove the release-notes / "What's New" announcement end to end so that:

- The modal never appears on upgrade (or at any other time).
- No dead code, unused routes, unused hooks, or unused API surface remain.
- No new lint / type-check / build failures are introduced.
- Config compatibility is preserved (no forced config-migration risk).

## Scope (what changes)

### Frontend (`packages/`)

1. **Delete** `packages/web-core/src/shared/dialogs/global/ReleaseNotesDialog.tsx`
   — the modal component.
2. **Delete** `packages/web-core/src/shared/hooks/useReleases.ts` — the query
   hook, used only by the dialog.
2b. **Delete** `packages/web-core/src/shared/components/SimpleMarkdown.tsx` — a
   markdown renderer whose **only** consumer is the deleted dialog (verified by
   grep). Removing it satisfies the "no dead code" requirement.
3. **Edit** `packages/local-web/src/routes/_app.tsx`:
   - Remove the `ReleaseNotesDialog` import.
   - Remove the `ReleaseNotesHandler` component definition.
   - Remove the `<ReleaseNotesHandler />` usage in `AppLayoutRouteComponent`.
   - Remove any imports left unused as a result (verify `useLocation`,
     `useUserSystem` are still used elsewhere in the file; only drop what
     becomes unused).
4. **Edit** `packages/web-core/src/shared/lib/api.ts`: remove the
   "Releases API (GitHub releases proxy)" block — `GitHubRelease` interface,
   `ReleasesResponse` interface, and the `releasesApi` object.

### Backend (`crates/`)

5. **Delete** `crates/server/src/routes/releases.rs` — the `/releases` proxy
   route (only consumer was the deleted frontend hook).
6. **Edit** `crates/server/src/routes/mod.rs`: remove `pub mod releases;` and the
   `.merge(releases::router())` line.
7. **Edit** `crates/local-deployment/src/lib.rs`: remove the version-change block
   that sets `show_release_notes = true`. Keep updating `last_app_version` so the
   persisted config still records the running version, and explicitly set
   `show_release_notes = false` on startup to clear any stale `true` persisted by
   an older build. See "Decisions" below.

## Decisions / trade-offs

- **Config field `show_release_notes` (and `last_app_version`) are kept in the
  config schema.** They live in the versioned config structs (current version
  `v9`). Dropping a field cleanly requires a new config version + migration
  (`v10`), which is higher-risk churn for zero user-visible benefit. Instead we
  **stop ever setting `show_release_notes = true`**; it stays at its default
  `false` and nothing reads it anymore, so the dialog can never open. This is the
  recommended, lowest-risk approach.
  - Consequence: the field remains in generated `shared/types.ts` (a
    `boolean`), harmlessly unused by the frontend. No `generate-types` change is
    required since the Rust config structs are untouched.

- **`last_app_version` handling.** Its only consumer was the release-notes
  trigger. We keep writing it (so config still reflects the installed version)
  but it no longer gates any UI. Removing the whole block is also acceptable
  since nothing else reads `last_app_version`; the implementation plan will pick
  one and justify it. Recommended: keep the version-write, drop only the
  `show_release_notes = true` line, to minimize behavioral change.

## Out of scope

- No config version migration (`v10`); `show_release_notes` /
  `last_app_version` fields stay in the schema.
- No changes to GitHub release publishing or CI.
- No changes to unrelated dialogs, onboarding, or settings UI.
- No `remote-web` changes (the handler lives in `local-web`; confirm the remote
  app does not import `ReleaseNotesDialog`/`useReleases`).

## Risks / notes

- **Unused-import / dead-code failures.** After editing `_app.tsx` and
  `api.ts`, run type-check + lint; TypeScript/ESLint will flag any now-unused
  imports. `crates` clippy will flag an unused `releases` module reference if the
  `mod.rs` edit is missed.
- **Shared vs. local.** `ReleaseNotesDialog` and `useReleases` live in
  `web-core` (shared). Confirm via grep that `remote-web` does not reference them
  before deleting (current grep shows only `local-web` + `web-core` internal
  references).
- **Route registration order** in `mod.rs` must remain valid after removing the
  `.merge(releases::router())` line (it sits mid-chain; remove exactly that line).
- **`SimpleMarkdown`** is imported **only** by `ReleaseNotesDialog` (verified by
  grep); deleting the dialog orphans it, so it is deleted too (step 2b). If a new
  consumer has appeared by implementation time, keep the file and note it.

## Acceptance criteria

1. On upgrading to a new version, **no "What's New" / release-notes modal
   appears** (the only trigger, `show_release_notes = true`, is gone).
2. There is **no `/api/releases` route** and no `releasesApi` /`useReleases` /
   `ReleaseNotesDialog` code remaining anywhere in the repo (grep-clean).
3. `pnpm run check` (frontend + backend type checks) passes.
4. `pnpm run lint` passes — no unused imports / dead code introduced.
5. `cargo test --workspace` (or at least `pnpm run backend:check`) passes;
   `crates/server` and `crates/local-deployment` compile without the removed
   module.
6. `shared/types.ts` is unchanged except where legitimately regenerated (expected:
   **no change**, since Rust config structs are untouched); `pnpm run
   generate-types:check` passes.
7. No behavioral regression elsewhere: app boots, config still loads/saves,
   `last_app_version` is still tracked (if the version-write is kept).

## Verification

From `vibe-kanban/`:

```
pnpm run check          # frontend + backend type checks
pnpm run lint           # ESLint + clippy
pnpm run generate-types:check
cargo test --workspace  # (or pnpm run backend:check)
grep -rniE "releaseNotes|useReleases|releasesApi|show_release_notes|/api/releases" \
  crates packages --include=*.rs --include=*.ts --include=*.tsx | grep -v node_modules
```

Expect the final grep to return **only** the retained config-struct field
definitions/defaults for `show_release_notes` (in `crates/services/.../versions/*`)
— and nothing referencing the dialog, hook, route, or API.
