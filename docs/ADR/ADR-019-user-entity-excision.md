# ADR-019: User entity excision — truly single user

- **Status**: Accepted
- **Date**: 2026-08-05
- **Refines**: ADR-018 (org excision — same pattern, next entity)
- **Relates to**: ADR-004 (local-only cloud removal)

## Context

ADR-018 removed the Organization entity; the fork is single-developer, local-only, no team, no auth. The same argument applies to the User entity: there is exactly one user — the owner — hardcoded as `LOCAL_USER_ID = Uuid::from_u128(0xA002)`. The `local_users` table holds a single row (the owner); `issues.creator_user_id` and `issue_comments.author_id` always equal `LOCAL_USER_ID`; `issue_assignees` is a junction of owner↔owner rows. Every value is trivially constant — there is no historical variation to preserve. Assignee selection, comment attribution, comment reactions, followers, and notifications are all either dead (no table/route/shape 404s) or meaningless (a single user assigning to themselves).

The goal: excise the User/assignee/creator/follower/reaction/notification architecture as if it never existed — UI, backend, DB, MCP, wire contracts. No placeholders.

## Decision

1. **DB (full drop, owner-approved "rework the DB as we like")**: new migration `20260807000001_drop_user_entities.sql`:
   - `DROP TABLE IF EXISTS issue_assignees;` (leaf junction, no outbound FK, safe)
   - `DROP TABLE IF EXISTS local_users;` (no inbound FK — `creator_user_id`/`issue_assignees.user_id` are bare BLOB, no REFERENCES)
   - `ALTER TABLE issues DROP COLUMN creator_user_id;` (unconstrained, safe)
   - `ALTER TABLE issue_comments DROP COLUMN author_id;` (unconstrained, safe)
   - Requires SQLite ≥ 3.35 (DROP COLUMN). Verify `sqlite_version()` in CI before merge; fall back to FK-toggled table rebuild if the bundled lib is older. The frozen-migration guard only locks `20260805000001` — the new file is unrestricted.

2. **Backend entities removed**: `local_user.rs` model, `UserWithProfile`/`ListUsersResponse` (api-types/user.rs), `issue_assignee.rs`, `issue_follower.rs`, `issue_comment_reaction.rs`, `notification.rs`, `oauth.rs` (LoginStatus) — all deleted. `Issue.creator_user_id`, `IssueComment.author_id`, `Workspace.owner_user_id`, `SearchIssuesRequest.assignee_user_id` — dropped from api-types + db models + all query_as! lists.

3. **Routes removed**: `/v1/users`, `/v1/fallback/users`, `/v1/fallback/issue_assignees`, `/v1/issue_assignees` (+{id}) in local_kanban.rs; `/issue-assignees` in kanban.rs; `LocalUser::ensure` calls in project_config/startup/main.rs; `login_status` from `UserSystemInfo` (config.rs).

4. **MCP**: `task_server/tools/issue_assignees.rs` deleted + router wiring removed. No other user-referencing MCP tool exists.

5. **Frontend — assignee/creator/follower/reaction/notification surfaces removed**: KanbanAssignee component, AssigneeSelectionDialog, assignee filter (useKanbanFilters/KanbanFilterBar), bulk-assign, keyboard shortcut + command-bar assignee actions, create-composer assigneeIds, comment author attribution, comment reactions, NotificationsPage + sidebar bell + notifications route. `KanbanContainer`/`KanbanIssuePanelContainer`/`IssueCommentsSectionContainer`/`IssueSubIssuesSectionContainer`/`IssueWorkspacesSectionContainer` drop useUsers/useNotifications and owner-user reads.

6. **Auth**: `LocalAuthProvider` stays as a trivial always-signed-in gate — it gates app mount (startup → app) and many consumers read `isSignedIn`/`isLoaded`. `userId` and `LOCAL_USER_ID` are removed from it; `useAuth` keeps `{ isSignedIn: true, isLoaded: true }` only. Consumers that only gated on `isSignedIn` are unaffected. `useCurrentUser`, `isOwnedByCurrentUser`, and `kanbanOrgId`-style identity plumbing are dropped.

7. **Context rename**: `UserContext`/`useUserContext`/`UserProvider` (which actually provide the workspace list) renamed to `WorkspacesContext`/`useWorkspacesContext`/`WorkspacesProvider` — the name was misleading and the user identity is gone. `USER_WORKSPACES_SHAPE` params `['owner_user_id']` → `[]` (renamed `WORKSPACES_SHAPE`).

8. **Wire contracts**: `shared/types.ts` regenerated (drops User/LoginStatus/IssueAssignee/Notification types + fields). `shared/remote-types.ts` hand-edited: delete Notification/IssueAssignee/IssueFollower/IssueCommentReaction/User/UserData types, their shapes (NOTIFICATIONS_SHAPE, USERS_SHAPE, PROJECT_ISSUE_ASSIGNEES_SHAPE, PROJECT_ISSUE_FOLLOWERS_SHAPE, ISSUE_REACTIONS_SHAPE) and mutations; drop `creator_user_id`/`author_id`/`owner_user_id`/`assignee_user_id` fields.

9. **KEEP AS-IS**: `crates/services/src/services/notification.rs` (OS desktop toast — unrelated), Azure DevOps `{org}` path segment, `crates/server/src/routes/workspaces/pr.rs` CLI auth errors, TUI + telegram-bridge crates (zero user references).

## Consequences

### Positive
- Data model matches wire reality: no user/assignee anywhere.
- Single-dev UX simplification: no "assigned to me" noise, no attribution ceremony, no notification bell that never rings.
- Follows the ADR-018 pattern; the entity layer is now just projects + boards + issues + comments + workspaces.

### Negative / accepted
- `useUserContext` → `WorkspacesContext` rename touches ~7 call sites (mechanical).
- macOS Swift app (`apps/macos/`, in-repo) mirrors `remote-types.ts` and needs a
  matching edit — tracked as `docs/TODO/swift-app-entity-excision.md` (same as ADR-018).
- Comment author/history: `author_id` column dropped — every comment was authored by the single owner, so no attribution is lost.
- `LoginStatus` wire removal is a breaking change for any out-of-repo consumer of `UserSystemInfo`.

## Risks
- **SQLite DROP COLUMN version** — verify ≥3.35 in CI; fallback documented.
- **Auth consumers**: `isSignedIn` gates in ProjectKanban/SharedAppLayout/UserProvider/ActionsProvider stay valid (always true). `userId` consumers (KanbanContainer, IssueWorkspacesSectionContainer, useNotifications, useUsers) are all being removed along with the user entity — no residual consumer survives the sweep.
- **Notification-page vs OS-toast**: only the kanban notification UI (bell, page, route, app dir) is removed; the OS toast service and `showSystemNotification` bridge stay.
- **Cross-repo**: Swift app wire mirror needs a follow-up — tracked as `docs/TODO/swift-app-entity-excision.md`.
