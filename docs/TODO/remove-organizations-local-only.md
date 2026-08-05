# Remove Organizations (local-only fork cleanup) — deferred

**Status**: Deferred. **Owner decision**: do when the local-only cleanup pass happens.
Not urgent — the backend already synthesizes a single "Local" org and ignores the
client's `organization_id`, so this is dead-weight frontend machinery, not a live bug.

## Why

The fork is single-developer/local-only. Organizations (org switcher, org-scoped
projects, members, roles) have no product value here. Today:

- **Backend is already synthetic**: `LOCAL_ORGANIZATION_ID` is hardcoded in the data
  routes (`crates/server/src/routes/kanban.rs:149`, `local_kanban.rs:76`), and
  `routes/organizations.rs` returns a fake "Local" org. **No `organizations` table in
  the DB** (zero migrations) — nothing to migrate.
- **Frontend still carries the full multi-org machinery** (~30 files in web-core):
  OrgProvider, org stores/hooks, `organization_id` threading through shape params and
  tanstack-query keys, settings sections, dialogs, user popover. The org switcher
  button is already deleted; the remaining surface is dormant.

So removal is **behavior-preserving** — the client sends `organization_id`, the
backend ignores it. The work is cleaning up the frontend, not fixing data.

## Blast radius (assessed 2026-08-03)

| Layer | Files | Notes |
|-------|-------|-------|
| Rust backend | ~6 | `routes/organizations.rs` (4 routes), `api-types/organizations.rs`, `api-types/organization_member.rs`, refs in `api-types/{notification,export,project,lib}.rs`, `LOCAL_ORGANIZATION_ID` const in `db/models/project.rs`, `bin/generate_types.rs`. Small, ~0.5 day. |
| `shared/remote-types.ts` | 1 | Org types (14 refs). Regenerate from `generate_types.rs` after Rust types drop. |
| **web-core (frontend)** | **~30** | **The bulk (see inventory below).** ~2-3 days. |
| packages/ui | 2 | Already mostly clean (switcher deleted). Trivial. |
| local-web | 0 | — |

### web-core inventory (~30 files)

- Core providers/hooks (10):
  - `shared/providers/remote/OrgProvider.tsx` (112 lines — mounts in `pages/kanban/ProjectKanban.tsx` + `dialogs/kanban/AssigneeSelectionDialog.tsx`)
  - `shared/stores/useOrganizationStore.ts`, `useUiPreferencesStore.ts` (selectedOrgId/clearSelectedOrgId)
  - `shared/hooks/{useOrganizationSelection,useOrganizationProjects,useAllOrganizationProjects,useOrganizationMembers,useNotificationMembers,useUserOrganizations,organizationKeys}.ts`, `useOrgContext`
- Data layer: `organization_id` in `PROJECTS_SHAPE` params (OrgProvider), tanstack `organizationKeys.*`, `shared/lib/api.ts` (`organizationsApi`, `/api/remote/projects?organization_id=…`)
- Navigation: `pages/root/RootRedirectPage.tsx`, `shared/lib/firstProjectDestination.ts`, `useUiPreferencesScratch.ts`
- UI surface: `dialogs/settings/settings/settingsRegistry.tsx` (OrganizationsSettingsSection), `OrganizationsSettingsSection.tsx`, `RemoteProjectsSettingsSection.tsx`, `dialogs/org/CreateRemoteProjectDialog.tsx`, `AppBarUserPopoverContainer.tsx` (already `organizations={[]}` — vestigial), `NavbarContainer.tsx`
- i18n: `i18n/locales/en/organization.json`, org keys in `settings.json`/`common.json`

## The change (when picked up)

Pragmatic path = **collapse to constant first, delete dead code in a second pass**:

1. **Rust + shared types (safe, do first):**
   - Delete `crates/server/src/routes/organizations.rs` and its mount in `routes/mod.rs`;
     keep `LOCAL_ORGANIZATION_ID` as a plain const (still used by kanban/local_kanban).
   - Delete `api-types/organizations.rs` + `organization_member.rs`; strip Org refs from
     `notification.rs`/`export.rs`/`project.rs`.
   - Regenerate `shared/remote-types.ts` via `pnpm run generate-types`.
2. **Frontend collapse (single scope):**
   - Force `organizationId = LOCAL_ORGANIZATION_ID` ("00000000-0000-0000-0000-000000000000")
     at the root (OrgProvider prop / selectedOrgId) so every shape param + query key is
     stable — no query-key churn, no stale cache.
   - Then delete, one cluster at a time, anything with no remaining callers: org hooks,
     `organizationsApi`, `organizationKeys`, org settings section, user-popover org bits.
   - `useNotificationMembers`: fall back to Local when `notification.organization_id` is
     absent (backend currently sends it — confirm before deleting the field).
   - Trim `useUiPreferencesStore` (selectedOrgId/clearSelectedOrgId) + scratch usage.
   - Drop `organization.json` locale + org keys from `settings.json`/`common.json`.
   - Fix `RootRedirectPage`/`firstProjectDestination` to resolve without an org hop.

## Risks

1. **Query-key / shape-param changes**: collapse must happen atomically — a half-migrated
   key space causes duplicate/stale queries. Do the constant-collapse first, then delete.
2. **Settings surface**: removing the Organizations section changes what Settings shows.
3. **Notifications members**: resolution keyed on `notification.organization_id` — needs
   the Local fallback.
4. **firstProjectDestination/RootRedirect**: currently routes via org+project; must not
   regress the redirect on first run.

## Acceptance

- `rg -i organization` in `packages/web-core/src` and `crates/server/src` returns only the
  `LOCAL_ORGANIZATION_ID` constant (or nothing if that is renamed too).
- `pnpm run check`, `pnpm --filter @vibe/ui run test`, `lint:i18n`, `pnpm run generate-types:check` green.
- Live smoke: first-run redirect, project tree, kanban, assignee dialog all work with no org hop.
