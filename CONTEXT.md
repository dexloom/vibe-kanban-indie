# CONTEXT — vibe-kanban-indie session handoff (compaction checkpoint, 2026-08-03)

## Project
`vibe-kanban-indie` — local-only single-dev fork of vibe-kanban (no cloud/auth/team). Rust backend (crates/server + deployment) + web frontend (packages/local-web entry, packages/web-core shared lib, packages/ui design system). Tailwind v3 + CSS custom properties theme. react-i18next (**ENGLISH-ONLY** — 6 other locales deleted). react-arborist 3.16 (pinned exact) sidebar tree. Vitest+jsdom test setup in packages/ui.

## Environment
- **Laptop (active)**: repo `~/yt/vibe-kanban-indie`. Branch `feat/ui-modernization`.
- **mini (remote Mac)**: `vladimir@mini` (192.168.1.218), repo `~/yt/vibe-kanban-indie`, cargo target on `/Volumes/Data/vk-target`. Not active.
- **Deploy**: `~/.vibe-kanban/bin/v0.2.23/macos-arm64/vibe-kanban`, running with `VK_FRONTEND_DIR=$PWD/packages/local-web/dist` → frontend-only iterate = `pnpm --filter @vibe/local-web run build` (no cargo). Port file: `/var/folders/.../vibe-kanban/vibe-kanban.port` (`main_port`), current **62253**.
- Checks: `pnpm --filter @vibe/{ui,web-core,local-web} run check` (tsc), `pnpm --filter @vibe/ui run test` (52 tests), `pnpm --filter @vibe/local-web run lint:i18n`, build. Playwright available: `NODE_PATH=/Users/vladimir/node_modules node <script>` (Brave executable path needed). Smoke scripts in `/var/folders/.../T/opencode/`.

## Git state (branch feat/ui-modernization) — WORKTREE CLEAN except transient
- `HEAD dd3859cc` — fix(ui): Tasks section review bugs (B1-B8) + cross-cutting hardening.
- Prior (all committed): `c0c6e640` (separator+margin), `1fd45821` (ADR-010 bar generalize + bottom bar), `9b610012` (badge 12px), `acd57b21` (solid badges), `517a65d0` (ADR-009 bucket bar), `c892d293` (i18n en-only), `c18852ef` (Active→Attention), `af30c0a9` (ADR-008 header+create), `e29bdee7` (sweep 3 hygiene), `3ed0bf1e` (review doc), `cb3ce353` (ADR-007 tree).
- The **Tasks section (ADR-011) Phase 1+2 was committed together with dd3859cc** (buildTreeData, node types, renderers, useProjectTasks, registry, SharedAppLayout wiring, tests, ADR-011).
- Transient (never commit): CONTEXT.md, SPEC-conversation-list.md, TODO.md.

## Session history (built so far)
1. **PR #9** (upstream) MERGED: dispatch issue→workspace.
2. **Cloud removal** (Phase 1-3): crates/remote, relay-*, remote-web, sentry/posthog/telemetry gone (~70k LOC). `shared/remote-types.ts` = live hand-maintained wire contract (kanban data layer, fallback-REST). Synthetic "Local" org.
3. **ADR-001 modal** (defineModal pure props/result, ProjectMutationsRegistration bridge), **ADR-002 centralized theme** (CSS vars → tailwind bridge; alpha modifiers `bg-x/15` DO work for hsl vars — verified).
4. **ADR-003** /workspaces dashboard + /chat smart redirect, workspaceStatus domain module.
5. **ADR-005** (amended) 256px global sidebar; **ADR-006** (superseded) view-local outliner.
6. **ADR-007** project-scoped workspace tree: Project → Workspaces section → buckets (Attention/Running/Idle/Archived) → leaves. Membership M:N frontend-derived (useWorkspaceProjectMembership from remote shapes), Unassigned pseudo-project. Persistence: versioned localStorage blob `vibe.ui.sidebarTree.openState` `{v:1,state}` + read-time project GC + legacy bucket migration. `activeWorkspaceId` highlight. react-arborist pinned + seed-once test.
7. **ADR-008** SidebarSectionHeader (h2 + actions slot) above tree as single a11y label source (aria-labelledby). Sidebar `headerActions` slot; CreateProjectButton (web-core) + restored handleCreateProject; `sidebar.createProject`.
8. **ADR-009** top bucket bar: 3 global buckets, `workspaceBuckets.ts` config SSOT (icon/color/labelKey/badgeClass/hideBadge); Attention=WarningIcon text-warning (new token), Running=ClockIcon, Idle=MoonIcon; icons+small labels, per-bucket SOLID badges (Idle none), dropdown down, newest-first. `WorkspaceActivityText` + `CountBadge` (color-agnostic) extracted.
9. **ADR-010** bar generalize: `SidebarBar` (toolbar-row container widget) + `SidebarBarButton` (forwardRef, spreads rest for Radix asChild) shared by top bucket bar AND bottom bar. Bottom = `SidebarBottomActions` (Notifications+Settings); org/user/version removed; drag strip + top padding removed then pt-2 + SidebarSeparator added back.
10. **ADR-011** Tasks section in tree (ABOVE Workspaces): Project → Tasks → status columns → issue card rows (simpleId+title+priority dot, title-row only, NO full card) → NESTED sub-issues. Lazy per-project loading via useProjectTasks (useShape PROJECT_PROJECT_STATUSES_SHAPE + PROJECT_ISSUES_SHAPE) gated on Tasks-section toggle. SidebarProjectTasksRegistry (web-core, per-project loaders). `openByDefault={false}` + new-project auto-open effect (preserves ADR-007). Statuses/cards collapsed by default. activeIssueId highlight, onSelectIssue → goToProjectIssue. i18n `sidebar.tasksSection`. TDD: 52 tests total.

## ADRs (docs/ADR/) — all Accepted
001 modal-system, 002 centralized-theme, 003 workspaces-chat-split, 004 local-only-cloud-removal, 005 left-sidebar-chats-tree (amended), 006 workspaces-outliner (superseded by 007), 007 sidebar-project-workspaces-tree, 008 sidebar-section-header, 009 sidebar-bucket-bar, 010 sidebar-bar-buttons, 011 sidebar-tasks-section.
Plans: `docs/PLAN-sidebar-*-2026-08-03.md`. Review consensus: `docs/REVIEW-sidebar-tree-2026-08-03.md`. Phase-2 TODO: `docs/TODO/phase2-workspaces-project-id.md`.

## Key architecture rules
- **Slots over prop-per-action callbacks** (headerActions, bottomActions, notificationBell...) — packages/ui stays agnostic; web-core composes buttons.
- **Layer rule**: packages/ui must NOT import web-core (types flow web-core→@vibe/ui). Domain module `workspaceStatus.ts` (ui) is shared.
- **Persistence**: one versioned blob; `buildSidebarTreeInitialOpenState` walks built tree (tree-walk), status/card ids NOT seeded (unknown at mount → openByDefault=false closes them); `readOpenTasksProjectIds` hydrates the lazy-loader gate on reload.
- **Dialogs pure** (ADR-001); **data lazy** (Tasks) via useShape gated on expansion; shape collections cache dedup (collections.ts) so sidebar shares streams with the board.
- **react-arborist seed-once**: initialOpenState consumed only at mount; post-mount its store owns state; new lazy nodes default per openByDefault.
- **i18n**: English-only; new keys → `packages/web-core/src/i18n/locales/en/common.json` only.

## Agents (how we work)
- `@escalate-glm` / `@escalate-deepseek` — parallel design/architecture variants; `@review-glm`/`@review-deepseek` — parallel code review (bugs/edge cases); `@boring_work` — implementation (TDD, slow); `@typewriter` — dumb mechanical only.
- Flow: design → ADR → escalate (parallel) → review → plan .md → TDD implement (red tests first) → verify myself → commit.
- Configs in ~/.config/opencode/agent/*.md (task:true everywhere; AGENTS.md delegation guide). boring_work CANNOT spawn typewriter at runtime (subagent-depth limit). consult agent deleted. Prettier has NO repo config → always `--single-quote`.
- Review bugs B1-B8 (Tasks): gate hydration, cycle guard, registry prune, type dedup, projectKey memo, seeded-only persistence, caret a11y. False positive: "double-action click" (react-arborist RowContainer has no onClick).

## Open items / next steps
1. Deferred Tasks follow-ups: deep-link to issue → auto-open Tasks section; loader-per-project perf at scale; bucket badge semantics (statuses count vs issue count).
2. Consider: push feat/ui-modernization / PR; run full `pnpm run lint` (clippy) + `pnpm run check` before merge.
3. Known debt: alpha modifiers OK for hsl vars (revisit ADR-002 note); two collapsible-state systems; Phase-2 workspaces.project_id migration.
4. MobileDrawer always in DOM → TWO `<aside aria-label="Primary sidebar">` (desktop + hidden drawer). Playwright smokes MUST scope: `aside:has([role="tree"])` + `.first()`, or native JS visibility check, or you click the hidden drawer's controls.

## Gotchas
- prettier: `pnpm exec prettier --write --single-quote <files>` (default flips to double quotes).
- react-arborist needs explicit width+height; height=0 → 0 rows (fixed via callback-ref + height>0 gate).
- Don't commit: CONTEXT.md, SPEC-conversation-list.md, TODO.md, opencode config/secrets, .env.
