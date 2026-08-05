# PLAN — Sidebar Section Header + Create Project Button (ADR-008)

- **Date:** 2026-08-03
- **Branch:** `feat/ui-modernization`
- **Status:** Ready to implement
- **ADR:** `docs/ADR/ADR-008-sidebar-section-header.md` (Accepted)
- **Reviewer verdict incorporated:** escalate-glm (slot over callback, native `<h2>`, `aria-labelledby`, focus-visible ring, Tooltip on `+`, factor button in web-core, header unconditional, no drag-region on header)

## Files to change

| # | File | Action |
|---|------|--------|
| 1 | `packages/ui/src/components/SidebarSectionHeader.tsx` | **NEW** — ui primitive |
| 2 | `packages/ui/src/components/Sidebar.tsx` | edit — add `headerActions` slot, `useId`, `useTranslation`, render header |
| 3 | `packages/ui/src/components/SidebarProjectTree.tsx` | edit — drop `aria-label`, accept `ariaLabelledBy` |
| 4 | `packages/web-core/src/shared/components/ui-new/containers/CreateProjectButton.tsx` | **NEW** — `+` button |
| 5 | `packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx` | edit — restore `handleCreateProject`, pass `headerActions` to both `<Sidebar>` |
| 6 | `packages/web-core/src/i18n/locales/{en,es,fr,ja,ko,zh-Hans,zh-Hant}/common.json` | edit — add `sidebar.createProject` |

---

## Step 1 — NEW `SidebarSectionHeader.tsx` (ui primitive)

Pure presentational component. No border, no bg, no drag-region. Renders an `<h2>` (native, not `role="heading"`). Stable id via prop or `useId()` fallback.

**File:** `packages/ui/src/components/SidebarSectionHeader.tsx`

```tsx
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface SidebarSectionHeaderProps {
  /** Plain string title (no JSX). Locked by contract. */
  title: string;
  /** Optional right-aligned action slot (e.g. ghost icon button). */
  actions?: ReactNode;
  /** Optional left adornment before the title. */
  leading?: ReactNode;
  /** Stable id for the <h2>. If omitted, a useId() is generated. */
  titleId?: string;
  className?: string;
}

export function SidebarSectionHeader({
  title,
  actions,
  leading,
  titleId,
  className,
}: SidebarSectionHeaderProps) {
  const autoId = useId();
  const id = titleId ?? autoId;
  return (
    <div
      className={cn(
        'flex h-7 shrink-0 items-center justify-between gap-1',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        {leading}
        <h2
          id={id}
          className="m-0 truncate text-xs font-semibold uppercase tracking-wide text-low"
        >
          {title}
        </h2>
      </div>
      {actions && (
        <div className="flex items-center gap-0.5">{actions}</div>
      )}
    </div>
  );
}
```

**Why `useId()` default:** `<Sidebar>` renders once per layout instance (desktop OR mobile drawer — never both; verified `SharedAppLayout.tsx:250` `!isMobile` vs `:286` `isMobile`). But a resize flips which branch mounts, and during a StrictMode double-invoke both could transiently appear. `useId()` guarantees DOM-unique ids per React instance, sidestepping the duplicate-id footgun a hardcoded `"sidebar-projects-heading"` literal would risk. Caller passes nothing; `Sidebar` threads the same id into the tree's `aria-labelledby`.

---

## Step 2 — Edit `Sidebar.tsx` (add slot, header, translation)

**File:** `packages/ui/src/components/Sidebar.tsx`

Three edits.

### 2a. Add imports + slot prop

Replace lines 1–7 (current imports):

```tsx
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import {
  SidebarProjectTree,
} from './SidebarProjectTree';
```

Add `headerActions?: ReactNode;` to `SidebarProps` (after `userPopover?: ReactNode;` at line 37):

```tsx
  notificationBell?: ReactNode;
  organizationsSwitcher?: ReactNode;
  userPopover?: ReactNode;
  /** Right-aligned actions for the Projects section header (e.g. create-project button). */
  headerActions?: ReactNode;
  appVersion?: string | null;
```

### 2b. Wire `useId` + `useTranslation` + destructure new prop

In the `Sidebar(...)` signature, add `headerActions` to destructured params (after `userPopover,`):

```tsx
  notificationBell,
  organizationsSwitcher,
  userPopover,
  headerActions,
  appVersion,
```

First lines of the function body (before `return (`):

```tsx
}: SidebarProps) {
  const { t } = useTranslation('common');
  const titleId = useId();
  return (
```

### 2c. Render header above the tree (between drag strip and tree)

Replace lines 76–89 (drag strip + `<SidebarProjectTree ... />`) with:

```tsx
      {/* Tauri drag strip — Windows/Linux only. On macOS the Navbar drag region
          covers the top; keeping the strip small and inert is harmless. */}
      <div data-tauri-drag-region className="h-7 shrink-0" aria-hidden="true" />

      <SidebarSectionHeader
        title={t('appBar.projects')}
        titleId={titleId}
        actions={headerActions}
      />

      <SidebarProjectTree
        projects={projects}
        activeProjectId={activeProjectId}
        workspaces={workspaces}
        archivedWorkspaces={archivedWorkspaces}
        membership={membership}
        activeWorkspaceId={activeWorkspaceId}
        isLoading={isLoadingProjects || isLoadingWorkspaces}
        onSelectWorkspace={onSelectWorkspace}
        onSelectProject={onSelectProject}
        onProjectsReorder={onProjectsReorder}
        ariaLabelledBy={titleId}
      />
```

**Note:** Header is **outside** the tree's `<section>` and carries **no** `data-tauri-drag-region` (ADR requirement). Drag strip above stays inert.

---

## Step 3 — Edit `SidebarProjectTree.tsx` (drop duplicated label)

**File:** `packages/ui/src/components/SidebarProjectTree.tsx`

### 3a. Accept `ariaLabelledBy`, drop `aria-label`

Edit `SidebarProjectTreeProps` (around line 26) — add `ariaLabelledBy?: string;`:

```tsx
interface SidebarProjectTreeProps {
  projects: readonly SidebarProject[];
  activeProjectId: string | null;
  workspaces: OutlinerWorkspace[];
  archivedWorkspaces?: OutlinerWorkspace[];
  membership: WorkspaceProjectMembership;
  activeWorkspaceId: string | null;
  isLoading?: boolean;
  onSelectWorkspace: (id: string) => void;
  onSelectProject: (id: string) => void;
  onProjectsReorder: (reorderedProjectIds: string[]) => void;
  /** Id of the external <h2> that labels this section. Replaces the old aria-label. */
  ariaLabelledBy?: string;
  width?: number;
  className?: string;
}
```

Destructure it (line 142–155):

```tsx
export function SidebarProjectTree({
  projects,
  activeProjectId,
  workspaces,
  archivedWorkspaces = [],
  membership,
  activeWorkspaceId,
  isLoading = false,
  onSelectWorkspace,
  onSelectProject,
  onProjectsReorder,
  ariaLabelledBy,
  width = 256,
  className,
}: SidebarProjectTreeProps) {
```

### 3b. Section: `aria-labelledby` instead of `aria-label`

Replace lines 370–373 (the `<section>`):

```tsx
  return (
    <section
      aria-labelledby={ariaLabelledBy}
      className={cn('flex min-h-0 flex-1 flex-col', className)}
    >
```

### 3c. (Gotcha) Inner `<Tree>` also has `aria-label`

**Discovered while reading:** line 409 of the current file passes `aria-label={t('appBar.projects')}` to `<Tree>`. This duplicates the label a third time inside the react-arborist role="tree". Same single-source principle applies.

Replace line 409:

```tsx
              aria-labelledby={ariaLabelledBy}
```

(Drop the `t('appBar.projects')` value; `t` remains used elsewhere — no dead-import.)

**If `ariaLabelledBy` is undefined** (e.g. tree used standalone in tests), both `aria-labelledby` attrs render as `aria-labelledby="undefined"` which screen readers ignore. Acceptable. The current Sidebar always passes it.

---

## Step 4 — NEW `CreateProjectButton.tsx` (web-core)

Ghost `+` button. Factored once, used by both Sidebar renders via `headerActions` (DRY — no inline JSX dup). Wrapped in `Tooltip` (matches existing Sidebar bottom-row pattern, `Sidebar.tsx:96`).

**File:** `packages/web-core/src/shared/components/ui-new/containers/CreateProjectButton.tsx`

```tsx
import { PlusIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@vibe/ui/components/Tooltip';

interface CreateProjectButtonProps {
  onClick: () => void;
}

export function CreateProjectButton({ onClick }: CreateProjectButtonProps) {
  const { t } = useTranslation('common');
  const label = t('sidebar.createProject');
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-haspopup="dialog"
        className={
          'flex size-6 items-center justify-center rounded-sm p-1 text-low ' +
          'hover:bg-tertiary hover:text-high transition-colors ' +
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        }
      >
        <PlusIcon className="size-icon-sm" weight="bold" />
      </button>
    </Tooltip>
  );
}
```

**Token verification (done while reading the repo):**
- `size-icon-sm` — **EXISTS**. Defined in `packages/local-web/tailwind.new.config.js:83` (`'icon-sm': getSize('sm', iconMultiplier)`). Heavily used across web-core (`ReposSettingsSection.tsx:470`, `SearchableTagDropdown.tsx:204`, etc.). Use it; do **not** fall back to `size-3.5`.
- `focus-visible:ring-ring` — real token (used in `ui/src/components/Switch.tsx:11`, `Checkbox.tsx:25`). Works in dark mode (ring-ring resolves via theme).
- `hover:bg-tertiary` / `text-low` / `text-high` — same tokens the existing open-kanban button uses (`treeNodes.tsx:54,87`).

**a11y notes (do NOT copy from `treeNodes.tsx` open-kanban):**
- That button uses `focus:outline-none` with no ring (`treeNodes.tsx:88`) — known a11y gap.
- This button uses `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring` — visible keyboard focus.
- `type="button"` (prevents form submit), `aria-haspopup="dialog"` (NOT `aria-controls` — dialog mounts via nice-modal portal on open, no stable DOM id at rest).

---

## Step 5 — Edit `SharedAppLayout.tsx` (handler + both renders)

**File:** `packages/web-core/src/shared/components/ui-new/containers/SharedAppLayout.tsx`

### 5a. Restore imports

Add to the import block at top of file (after the `CreateRemoteProjectDialog` import was removed in `cb3ce353`). Place alphabetically with the other `@/shared/dialogs/org/*`-style imports — insert after line 22 (`CommandBarDialog` import):

```tsx
import { CommandBarDialog } from '@/shared/dialogs/command-bar/CommandBarDialog';
import {
  CreateRemoteProjectDialog,
  type CreateRemoteProjectResult,
} from '@/shared/dialogs/org/CreateRemoteProjectDialog';
import { CreateProjectButton } from './CreateProjectButton';
```

### 5b. Restore `handleCreateProject` (cb3ce353-pre-deletion shape)

Add after `handleProjectClick` (after line 141, before `handleProjectsReorder`):

```tsx
  const handleCreateProject = useCallback(async () => {
    if (!selectedOrgId) return;

    try {
      const result: CreateRemoteProjectResult =
        await CreateRemoteProjectDialog.show({ organizationId: selectedOrgId });

      if (result.action === 'created' && result.project) {
        appNavigation.goToProject(result.project.id);
      }
    } catch {
      // Dialog cancelled — no-op.
    }
  }, [selectedOrgId, appNavigation]);
```

**StrictMode note:** handler is event-driven (user click), not effect-driven. React.StrictMode double-invokes effects and renders, not user-event handlers. `CreateRemoteProjectDialog.show()` will fire once per click. Safe.

### 5c. Pass `headerActions` to BOTH Sidebar renders

**Desktop (line 255):** add after `onSelectProject={handleProjectClick}` (line 266):

```tsx
              onSelectWorkspace={(id) => appNavigation.goToWorkspace(id)}
              onSelectProject={handleProjectClick}
              headerActions={<CreateProjectButton onClick={handleCreateProject} />}
              notificationBell={
```

**Mobile drawer (line 322):** add after `onSelectProject` block (after line 336):

```tsx
                onSelectWorkspace={(id) => appNavigation.goToWorkspace(id)}
                onSelectProject={(id) => {
                  handleProjectClick(id);
                  setIsDrawerOpen(false);
                }}
                headerActions={<CreateProjectButton onClick={handleCreateProject} />}
                organizationsSwitcher={<OrganizationSwitcherButton />}
```

`<CreateProjectButton />` is one component, two usages — no JSX duplication. Handler is shared; click → opens dialog over the drawer. Dialog navigation does **not** close the drawer (drawer closes via `setIsDrawerOpen(false)` only on row click). Acceptable — drawer auto-hides on navigation to a non-mobile route anyway. If user cancels dialog, drawer remains open with the new state. Fine.

---

## Step 6 — i18n: add `sidebar.createProject` to all 7 locales

Single key, added into the existing `sidebar` object in each `common.json`. The repo's `scripts/check-i18n.sh` enforces key parity across all locales — **missing key in any locale fails `pnpm run lint`**.

| Locale | Value |
|--------|-------|
| `en` | `Create project` |
| `es` | `Crear proyecto` |
| `fr` | `Créer un projet` |
| `ja` | `プロジェクトを作成` |
| `ko` | `프로젝트 만들기` |
| `zh-Hans` | `创建项目` |
| `zh-Hant` | `建立專案` |

**Per-file edit shape** (same in all 7 files; only the value changes). Edit the `sidebar` block — currently:

```json
  "sidebar": {
    "workspacesSection": "Workspaces",
    "unassigned": "Unassigned",
    "openProjectKanban": "Open project kanban"
  }
```

becomes:

```json
  "sidebar": {
    "workspacesSection": "Workspaces",
    "unassigned": "Unassigned",
    "openProjectKanban": "Open project kanban",
    "createProject": "Create project"
  }
```

(values translated per the table above; remember to add the trailing comma after `openProjectKanban`).

---

## Verification checklist

Run from repo root, in order:

```bash
# Type-check the three touched packages
pnpm --filter @vibe/ui run check
pnpm --filter @vibe/web-core run check
pnpm --filter @vibe/local-web run check

# i18n parity + unused-key check (the real "lint:i18n")
bash scripts/check-i18n.sh
node scripts/check-unused-i18n-keys.mjs

# Lint (includes both i18n scripts above + eslint)
pnpm run lint

# Unit tests for ui (covers existing SidebarProjectTree seed-once test)
pnpm --filter @vibe/ui run test

# Full build
pnpm --filter @vibe/local-web run build
```

**Runtime check** (manual or headless — `pnpm run dev`, exercise UI):

- [ ] Header visible above the project tree (desktop) — "PROJECTS" text, `text-xs font-semibold uppercase tracking-wide text-low`.
- [ ] `+` button visible at right of header; tooltip "Create project" appears on hover after 300ms delay.
- [ ] Click `+` → `CreateRemoteProjectDialog` opens, prefilled org = `selectedOrgId`.
- [ ] Submit dialog → new project navigates (`appNavigation.goToProject`); project appears in tree.
- [ ] Cancel dialog (Esc / Cancel btn) → no navigation, no console error.
- [ ] Mobile viewport: open drawer → header + `+` present; click `+` → dialog opens over drawer.
- [ ] DOM inspection: exactly one `<h2 id=...>` per Sidebar instance; `<section aria-labelledby="{same id}">`; `<div role="tree" aria-labelledby="{same id}">`. No duplicate "Projects, Projects" announced by screen reader.
- [ ] Keyboard: Tab to `+` → `focus-visible:ring-2 ring-ring` outline visible in both light and dark theme.
- [ ] No React warnings in console (no duplicate id, no missing key).
- [ ] No `data-tauri-drag-region` on header row (verify via DOM inspector).

---

## Risks / edge cases

1. **Mobile drawer button** — handled: `headerActions` passed to both `<Sidebar>` renders (Step 5c). Drawer does not auto-close on dialog open; acceptable per ADR.
2. **Focus ring in dark mode** — `ring-ring` is a theme token (`tailwind.new.config.js`); resolves to a light ring in dark mode. Verified pattern in `Switch.tsx`, `Checkbox.tsx`. No extra work.
3. **StrictMode double-open** — `handleCreateProject` is a `useCallback` invoked on click. StrictMode double-invokes effects/renders, **not** event handlers. `nice-modal-react`'s `show()` returns a fresh promise per call. Safe.
4. **`useId` vs explicit `titleId`** — Chosen `useId()` default inside `Sidebar` (Step 2b). Reason: Sidebar can mount twice transiently during desktop↔mobile transitions; hardcoded `"sidebar-projects-heading"` would yield duplicate DOM ids. `useId()` is React-instance-scoped, always unique. `SidebarSectionHeader` still accepts an explicit `titleId` prop for testing or non-Sidebar reuse — but `Sidebar` itself passes its own `useId()`.
5. **`ariaLabelledBy` undefined in standalone tree use** — Tests / other consumers might not pass it. Renders `aria-labelledby="undefined"` which screen readers ignore gracefully. No crash. Documented in Step 3c.
6. **Trailing comma in i18n JSON** — Easy to forget when adding `createProject` after `openProjectKanban`. JSON parser will reject the file → build fails loud. Re-run `bash scripts/check-i18n.sh` to localize the offending file.
7. **`lint:i18n` is not a real npm script** — User-facing task spec mentioned `lint:i18n`. The actual commands are `bash scripts/check-i18n.sh` (parity) and `node scripts/check-unused-i18n-keys.mjs` (unused). Both wired into `pnpm run lint`. Verification section above uses the real commands.

---

## Out of scope (ADR items NOT implemented this pass)

None. All ADR-008 decisions map to a step above.

## Open questions resolved during code reading

- **Does `size-icon-sm` exist?** Yes — `tailwind.new.config.js:83`. Use it (not `size-3.5`).
- **Is `appNavigation.goToProject` reachable?** Yes — already used by `handleProjectClick` (`SharedAppLayout.tsx:138`). Hook returns it; no extra import needed.
- **Is `selectedOrgId` in scope in `SharedAppLayout`?** Yes — line 75.
- **Does `<Tree>` accept `aria-labelledby`?** Yes — react-arborist 3.16.0 passes unknown props through; `aria-*` lands on the `role="tree"` div. Already accepts `aria-label` at line 409.
- **Is `Tooltip` API compatible?** Yes — `Tooltip` takes `{ content, children, side }` (`Tooltip.tsx:6`); exactly what Step 4 uses.
