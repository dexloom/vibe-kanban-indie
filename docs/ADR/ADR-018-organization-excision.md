# ADR-018: Organization entity excision

- **Status**: Accepted
- **Date**: 2026-08-05
- **Relates to**: ADR-004 (local-only cloud removal), ADR-013 (project boards), ADR-016 (orchestrator prompts)

## Context

ADR-004 collapsed the multi-tenant "organization" entity to a synthetic single-org stub —
a `LOCAL_ORGANIZATION_ID` constant (`Uuid::from_u128(0xA001)`) hardcoded into every
project/notification/notification assignee/exporter, with a no-op `GET /v1/organizations`
that returned the stub and a `GET /v1/organizations/{id}/members` that returned 501.
That decision preserved the kanban wire shape (the data layer is org-scoped) while
removing the cloud/team machinery.

The fork is **single-developer, local-only, no team, no cloud, no auth**. The stub
is a placeholder for an entity that will never exist. It now produces concrete noise:

- **Backend**: `organization_id: Uuid` leaks into `Project`, `Notification`,
  `CreateProjectRequest`, `ListProjectsQuery`, `ExportRequest`, `Organization`,
  `OrganizationMember`, `MemberRole`, `Invitation`, `InvitationStatus`, the
  `McpContext` literal, the MCP `organizations` tool, `routes/organizations.rs`, and
  the `OrgProvider` React tree. Every constructor hardcodes the same UUID.
- **Wire contracts**: `shared/types.ts` (auto-generated) and `shared/remote-types.ts`
  (hand-maintained per ADR-004) both resurrect the stub on every project/notification.
- **Frontend**: `OrgProvider`, `useOrgContext`, `useOrganizationStore`,
  `useUserOrganizations`, `useAllOrganizationProjects`, `useOrganizationSelection`,
  `organizationKeys`, `OrganizationsSettingsSection`, `RemoteProjectsSettingsSection`
  (already dead after ADR-004 but left in tree), assignee dropdown fetches through
  `/v1/organizations/{id}/members`, app bar org switcher, `CreateRemoteProjectDialog`,
  sidebar "team / org" guide.
- **i18n**: `en/organization.json` namespace mirrors the orphan entity.

The stub is **entirely virtual**: no DB table, no DB column, no migration needed. The
investigation confirms `rg -i organization crates/db/migrations/` returns 0 hits, and
`Project` (`crates/db/src/models/project.rs`) has no `organization_id` column. The
only persistence footprint is a JSON blob inside `UiPreferencesData.selected_org_id`
(`crates/db/src/models/scratch.rs:138`) — `#[serde(default)]` plus unknown-key tolerance
means old payloads still deserialize cleanly after the field is removed.

Azure DevOps uses the word **"organization"** as a URL path segment in
`crates/git-host/src/azure/*` (`{org}/{project}/_apis/...`). This is a third-party
domain term, NOT the product `Organization` entity — DO NOT touch.

## Decision

Drop the `Organization` entity, type, route, MCP tool, provider, and wire field
**entirely**, as if it never existed. The single-tenant reality becomes the data model.

### 1. Backend types (`crates/api-types/src/`)

- `Project` (L11), `CreateProjectRequest` (L40), `ListProjectsQuery` (L61): drop
  `organization_id: Uuid`.
- `Notification` (L38): drop `organization_id: Uuid`.
- `ExportRequest` (L7): drop `organization_id: Uuid`; rewrite the doc comment from
  "If empty, exports all projects in the organization." to "If empty, exports all
  projects.".
- `lib.rs`: remove `pub mod organization_member;`, `pub mod organizations;`, the
  matching `pub use` re-exports.
- DELETE `organizations.rs` and `organization_member.rs` whole files. `MemberRole` /
  `OrganizationMember` are only re-exported by the deleted files and the MCP org
  tool (deleted in §3) — no other consumer.

### 2. Backend models

- `crates/db/src/models/project.rs` (L7-10): delete the `LOCAL_ORGANIZATION_ID` const
  + its doc comment.
- `crates/db/src/models/scratch.rs` (L138-140): drop `selected_org_id: Option<String>`
  from `UiPreferencesData`. The `payload` JSON column retains the key harmlessly
  (`#[serde(default)]` + unknown-key ignore); deserialization is forward-compatible.

### 3. Backend routes

- `routes/local_kanban.rs`: remove `organization_id: LOCAL_ORGANIZATION_ID` from the
  `to_api_project` literal (L81 and any other struct literal); drop the
  `list_organizations` handler (L246) and `list_org_members` handler; remove the
  `.route("/v1/organizations", …)` and `.route("/v1/organizations/{org_id}/members", …)`
  lines (L1110-1111); drop now-unused `api_types` imports
  (`ListOrganizationsResponse`, `MemberRole`, `OrganizationMemberWithProfile`,
  `OrganizationWithRole`, …).
- `routes/kanban.rs`: same `to_api_project` fix + remove `LOCAL_ORGANIZATION_ID` import.
- DELETE `routes/organizations.rs` (whole file, 106 LOC).
- `routes/mod.rs`: drop `pub mod organizations;` (L41) and `.merge(organizations::router())`
  (L67).
- `bin/generate_types.rs`: remove the `api_types::Organization*::decl()` and
  `OrganizationMember*::decl()` lines (~L74-80, L88-89) so the regen script does
  not regress.

### 4. New users endpoint

The old `/v1/organizations/{org_id}/members` fed the assignee dropdown with every
local user. Replace it with a tenant-less endpoint so the assignee picker still has
a backing store. Add `GET /v1/users` to `routes/local_kanban.rs`, returning
`{ "users": [UserWithProfile, …] }` mirroring the shape `fb_users` already returns
for the feedback/users payload — reuse `LocalUser::list_all` if present, otherwise
mirror the query.

### 5. MCP

- DELETE `crates/mcp/src/task_server/tools/organizations.rs`.
- `tools/mod.rs`: drop `mod organizations;`, `+ Self::organizations_tools_router()`,
  the `resolve_organization_id` method (L237-249). In test fixtures, drop
  `organization_id: None,` from `McpContext` literals (~L400, L441).
- `task_server/mod.rs`: remove `LOCAL_ORGANIZATION_ID` const + doc (L14-17); drop
  `organization_id: Option<Uuid>` from `McpContext` (L38-39) + its schemars
  description; remove `let organization_id = project_id.map(|_| LOCAL_ORGANIZATION_ID);`
  (L205) and the `organization_id` field in the `McpContext` literal (L208).
- `tools/orchestrator_prompt.rs`: drop `organization_id: None` from test
  `McpContext` literals (~L152-156, L176, L228).

### 6. Wire contracts

- `pnpm run generate-types` regenerates `shared/types.ts` — `Organization*`,
  `Invitation*`, `MemberRole`, `InvitationStatus`, `OrganizationMember*` are
  dropped; `Project`, `Notification`, `CreateProjectRequest`, `ExportRequest` lose
  `organization_id`.
- `shared/remote-types.ts` is hand-maintained (per ADR-004) — edit by hand:
  - `Project` (~L7): delete `organization_id: string,`.
  - `Notification` (~L9): delete `organization_id: string,`.
  - Delete `MemberRole` enum + `OrganizationMember` type (~L70-72).
  - `CreateProjectRequest` (~L79): delete `organization_id: string,`.
  - `ExportRequest` (~L158): delete `organization_id: string,` + fix doc.
  - `PROJECTS_SHAPE` (~L184-189): `['organization_id']` → `[]`.
  - DELETE `ORGANIZATION_MEMBERS_SHAPE` (~L198-203).
  - `USERS_SHAPE` (~L205-210): `['organization_id']` → `[]`.
- `packages/web-core/src/shared/lib/electric/collections.ts`: confirm
  `buildSourceKey`/`buildUrl`/`createShapeCollection` tolerate empty params `[]`/`{}`
  (URL/cache-key building). If they crash, harden (e.g. `params ?? {}`).

### 7. Frontend core

- New `packages/web-core/src/shared/providers/ProjectProvider.tsx`:
  - Wraps children.
  - Subscribes `useShape(PROJECTS_SHAPE, {}, { mutation: PROJECT_MUTATION })`.
  - Exposes projects + users (from a new `useUsers` hook).
  - Mirror `OrgProvider.tsx`'s context shape minus the org.
- New hooks:
  - `packages/web-core/src/shared/hooks/useProjects.ts` (was `useOrganizationProjects`)
    — drop `orgId`, call `useShape(PROJECTS_SHAPE, {})`.
  - `packages/web-core/src/shared/hooks/useUsers.ts` (was `useOrganizationMembers`) —
    call `usersApi.getUsers()`.
- DELETE: `OrgProvider.tsx`, `useOrgContext.ts`, `useOrganizationStore.ts`,
  `useUserOrganizations.ts`, `useAllOrganizationProjects.ts`,
  `useOrganizationSelection.ts`, `organizationKeys.ts` (repurpose as `userKeys.ts`
  if used elsewhere — verified before deletion).
- `lib/api.ts`:
  - DELETE `organizationsApi` (~L1564-1579).
  - DELETE `remoteProjectsApi` (~L1581-1592, dead post-ADR-004).
  - ADD `usersApi.getUsers()` targeting `/v1/users` matching existing api-shape
    patterns.
- `lib/firstProjectDestination.ts`: drop `setSelectedOrgId` + org fetch; subscribe
  `PROJECTS_SHAPE`, return saved project by id if exists else first project by order.
- `components/ui-new/containers/SharedAppLayout.tsx`: drop `useUserOrganizations`,
  `useOrganizationStore`, auto-select-org effect, `selectedOrgId` gates on
  `useShape`, the org-name display (~L673), `CreateRemoteProjectDialog.show({ organizationId })`
  calls (drop the arg), `useOrganizationProjects` → `useProjects`. Thread the new
  `ProjectProvider` context where needed.
- `pages/kanban/ProjectKanban.tsx`: `useFindProjectById` → direct `PROJECTS_SHAPE`
  lookup; replace `<OrgProvider organizationId={…}>` with `<ProjectProvider>`.
- `dialogs/kanban/AssigneeSelectionDialog.tsx` (~L13, L255-280): drop `OrgProvider`
  wrap + `project?.organization_id`; use the new users context/hook by project id.
- `providers/ActionsProvider.tsx` (~L44-45, L217, L250): drop `selectedOrgId` from
  the store + `kanbanOrgId: selectedOrgId` from the actions context.
- `actions/index.ts` (~L447): drop `organizationId: ctx.kanbanOrgId`.
- `lib/persistIssues.ts` (~L96, L105): drop `orgId` param from `persistProjectReorder`;
  `refreshShapeSource(PROJECTS_SHAPE, { organization_id: orgId })` →
  `refreshShapeSource(PROJECTS_SHAPE, {})`.

### 8. Frontend dialogs / settings / UI

- DELETE `dialogs/settings/settings/OrganizationsSettingsSection.tsx` and
  `RemoteProjectsSettingsSection.tsx`.
- `settings/settingsRegistry.tsx`: remove `organizations` from section-id union +
  nav array + case clause.
- `SettingsDialog.tsx` (~L164, L214): drop `organizations` active-section case +
  `setActiveSection('organizations')` call.
- Rename + rewrite `dialogs/org/CreateRemoteProjectDialog.tsx` →
  `dialogs/CreateProjectDialog.tsx` (move out of `org/`). Drop `organizationId`
  prop + `organization_id` from insert body. Update all imports (`SharedAppLayout`,
  `RootRedirectPage`).
- `pages/root/RootRedirectPage.tsx`: drop `useOrganizationStore` + `setSelectedOrgId`;
  update `getFirstProjectDestination` call.
- `components/ui-new/containers/NavbarContainer.tsx` (~L149-151): drop org-name display.
- `ui/src/components/AppBarUserPopover.tsx` + Container: drop `organizations` /
  `selectedOrgId` props + org switcher.
- `ui/src/components/ProjectsGuideDialog.tsx` (~L69-73): drop the org/team guide step.
- `shared/stores/useUiPreferencesStore.ts`: drop `selectedOrgId` state + setters
  (~L353-354, 440-441, 486-487, 844-846).
- `pages/projects/OrchestratorPromptEditor.tsx` (~L8, L27, L94-152): drop
  `useSelectedOrgId` + org-scoped `refreshShapeSource` invalidation.
- `features/kanban/ui/KanbanContainer.tsx` (L182 doc) +
  `pages/kanban/KanbanIssuePanelContainer.tsx` (L148 doc): update the "Must be
  rendered within OrgProvider" doc comments to reference `ProjectProvider`.
- `shared/hooks/useNotificationMembers.ts`: drop org map; use `useUsers()` once.

### 9. i18n + tests

- DELETE `packages/web-core/src/i18n/locales/en/organization.json`; edit
  `i18n/config.ts` (~L12, L20) to drop the import + namespace.
- Fix test fixtures: `buildProjectBreadcrumb.test.ts` (~L11),
  `projectOrder.test.ts` (~L8), `persistIssues.test.ts` (~L237) — drop
  `organization_id` from `Project` fixtures / shape params.

### 10. Scope expansion justified

The opportunistic `RemoteProjectsSettingsSection.tsx` deletion is in scope: it has
been dead since ADR-004 (the cloud-remote UI it gated was deleted; the only call
site was `SettingsDialog`'s `organizations` section, which is also deleted here).
Leaving it in the tree would be a regression vector as future contributors try to
re-attach it to surviving surfaces.

## Consequences

### Positive

- The data model matches the deployment reality: one local user, no tenants, no
  team membership, no invitations. ~30 files deleted, ~15 files modified, zero
  net new abstractions.
- The wire contract shrinks: `Project`, `Notification`, `CreateProjectRequest`,
  `ExportRequest` no longer carry a phantom UUID. The `Organization*` /
  `OrganizationMember*` / `MemberRole` / `Invitation*` / `InvitationStatus` types
  disappear from `shared/types.ts` and `shared/remote-types.ts`.
- The frontend tree is simpler: no `OrgProvider`, no org switcher, no
  `OrganizationsSettingsSection`, no `RemoteProjectsSettingsSection`, no
  `CreateRemoteProjectDialog`. The assignee dropdown gets a tenant-less
  `usersApi.getUsers()`.

### Negative / accepted

- **`shared/remote-types.ts` + the macOS Swift app must be edited by hand** —
  the type generator is gone (per ADR-004). The Swift app mirrors the same shapes
  and likewise loses the `organization_id` field. Documented as a follow-up since
  the Swift app is out-of-repo.
- Future multi-tenant re-introduction requires re-adding the entity + the
  migration + provider + wire fields. Acceptable: a solo-dev fork has no such
  plans, and the cost is well-understood & documented.
- The `selected_org_id` JSON key remains harmless in any pre-existing
  `ui_preferences.payload` rows. No migration needed; the store is a proto-JSON
  blob.

### Risks

- **Silent breakage of the assignee dropdown** if the new `GET /v1/users` shape
  diverges from what `AssigneeSelectionDialog` expects. Mitigation: mirror the
  existing `fb_users` shape exactly; `UserWithProfile` is the wire contract.
- **Stale references missed in the sweep** — `organization_id` /
  `OrgProvider` / `setSelectedOrgId` could survive in a file the spec didn't
  pre-list. Mitigation: final `rg -i "organization" crates/ packages/ shared/`
  sweep; only Azure DevOps hits (out of scope) and the new ADR may remain.
- **Wire cache invalidation** — the dropdown data shape change is a
  wire-shape change (`OrganizationMember` → `UserWithProfile`). Acceptable for a
  solo-dev fork; txid bump on the new endpoint is sufficient.

## Cross-repo follow-ups

- `shared/remote-types.ts` is hand-maintained; the macOS Swift app mirrors it
  directly. The Swift app must drop `organization_id` from `Project` /
  `Notification` / `CreateProjectRequest` / `ExportRequest` and drop
  `OrganizationMember` / `MemberRole`. Out of repo — track as a separate task.

## Implementation order (TDD)

1. Phase 1 — backend types (`api-types`, `db::models`).
2. Phase 2 — backend routes (`local_kanban`, `kanban`, `organizations`, `mod`) +
   new `users` endpoint.
3. Phase 3 — MCP (`tools/organizations.rs`, `mod.rs`, `tools/mod.rs`,
   `orchestrator_prompt.rs`).
4. Phase 4 — wire contracts (`generate-types` + hand-edit `remote-types.ts`).
5. Phase 5 — frontend core (`ProjectProvider`, hooks, `lib/api.ts`,
   `firstProjectDestination`, `SharedAppLayout`, `ProjectKanban`,
   `AssigneeSelectionDialog`, `ActionsProvider`, `actions/index.ts`,
   `persistIssues`).
6. Phase 6 — frontend dialogs / settings / UI (settings sections, dialogs,
   navbar, app bar, guide, prefs store, orchestrator editor, doc comments,
   `useNotificationMembers`).
7. Phase 7 — i18n + tests + final `cargo test --workspace`, `pnpm run check`,
   `pnpm run lint`, `pnpm run generate-types`, `pnpm run format`.
