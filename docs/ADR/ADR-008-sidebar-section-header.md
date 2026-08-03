# ADR-008: Sidebar section header — reusable label + actions row

- **Status**: Proposed
- **Date**: 2026-08-03
- **Relates to**: ADR-007 (project-scoped workspace tree in the global sidebar),
  ADR-005 (global sidebar), ADR-002 (centralized theme), ADR-001 (modal system)

## Context

The global sidebar (ADR-007) renders a bare tree with no label identifying its
content, and project creation is currently **unwired**: the old
`handleCreateProject` handler was deleted as dead code (review sweep 1, M6)
because it had no caller. The user asks for:

1. A **section label** at the top of the sidebar that names the content below
   (here: "Projects").
2. **Action buttons on the right** of that label — here a single `+` button to
   create a new project (the create-project dialog exists; only the entry point
   is missing).
3. No outline/box around the content; sizing and color must make it obvious the
   area below belongs to the label. Best readability, eyes-easy sizes.
4. Everything we build must be architecturally sound and DRY.

ADR-007 also anticipates future per-project sections (TODO, Notes) alongside
"Workspaces"; each will need the same label affordance. So this is a reusable
component, not a one-off "Projects" heading.

## Decision

### `SidebarSectionHeader` (packages/ui)

A pure, presentational component in `packages/ui/src/components/SidebarSectionHeader.tsx`:

```ts
interface SidebarSectionHeaderProps {
  /** Translated section label. Locked to string for i18n discipline — no JSX
   *  in the label. A future icon prefix goes in `leading`, not here. */
  title: string;
  /** Right-aligned action slot (icon buttons, counts, ...). Skipped when
   *  undefined, so the header collapses to a plain label otherwise. */
  actions?: ReactNode;
  /** Optional prefix slot (icon, badge) — reserved for future sections. */
  leading?: ReactNode;
  /** id on the underlying <h2>; pass to a controlled region's
   *  aria-labelledby. Falls back to a generated id. */
  titleId?: string;
  className?: string;
}
```

Rendering:

- A flex row: `flex h-7 shrink-0 items-center justify-between gap-1`.
- Label: a native `<h2>` (id from `titleId` or `useId`) with
  `m-0 truncate text-xs font-semibold uppercase tracking-wide text-low`.
  Native heading = role + level + DOM outline for free; the app uses `<h1>`
  for page titles, so `<h2>` is the right level under them.
- Actions: right-aligned, `flex items-center gap-0.5`.
- **No outline / no border box** — a label row only. The "this belongs
  together" cue is proximity + a consistent header row every future section
  repeats.
- Header renders **unconditionally** above the tree's loading and empty
  states (it lives outside the tree).

The uppercase micro-label is the standard sidebar-section idiom (VS Code,
Linear); `text-xs` (12px) + `font-semibold` + `text-low` keeps it legible but
clearly secondary to the 16px project rows it introduces, and below the
`font-bold` active-project row (header must read as structural, not selected).
Row height 28px (`h-7`) gives a comfortable hit target without crowding.

### Placement

`Sidebar.tsx` renders `<SidebarSectionHeader title={t('appBar.projects')}>`
**above** `<SidebarProjectTree>`, between the Tauri drag strip and the tree.
The tree stays focused on the tree.

**Single label source (a11y)**: `SidebarProjectTree`'s outer
`<section aria-label={t('appBar.projects')}>` must switch to
`<section aria-labelledby={titleId}>` (e.g. `sidebar-projects-heading`) and
drop its `aria-label` — otherwise screen readers announce "Projects, Projects".
The header's `<h2>` becomes the one label for the tree below.

The header must NOT carry `data-tauri-drag-region` (it holds an interactive
button; the inert drag strip stays above it).

### Project creation wiring (the `+` button)

Sidebar already receives three ReactNode slots — `notificationBell`,
`organizationsSwitcher`, `userPopover`. Project creation follows the SAME slot
pattern (DRY), not a prop-per-action callback:

1. **`Sidebar` gains `headerActions?: ReactNode`** — rendered into the header's
   actions slot. Sidebar stays fully agnostic: no `PlusIcon`, no
   `sidebar.createProject` lookup, no dialog awareness. A prop-per-action
   callback (`onCreateProject?`) is rejected: it would force project knowledge
   into packages/ui and proliferate (`onCreateTodo?`, `onCreateNote?`) per
   future ADR-007 section.
2. **`SharedAppLayout` restores the deleted `handleCreateProject`** (review
   sweep 1 M6, original shape at commit `cb3ce353`): open
   `CreateRemoteProjectDialog.show({ organizationId: selectedOrgId })`, on
   `{ action: 'created', project }` navigate to the project. It becomes a live
   consumer, not dead code.
3. **`CreateProjectButton`** (web-core, new): the `+` ghost button composed by
   the layer that owns the dialog. SharedAppLayout passes
   `headerActions={<CreateProjectButton onClick={handleCreateProject} />}` to
   BOTH Sidebar renders (desktop + mobile drawer) — no JSX duplication.
   Spec:
   - `PlusIcon` (Phosphor, `size-icon-sm`, `weight="bold"`), wrapped in
     `<Tooltip content={t('sidebar.createProject')}>`.
   - Always visible but low-contrast: `text-low hover:text-high
     hover:bg-tertiary`, `size-6 rounded-sm p-1`.
   - `type="button"`, `aria-label={t('sidebar.createProject')}`,
     `aria-haspopup="dialog"` (opens a dialog — NOT `aria-controls`, which is
     for toggling a collapsible region).
   - `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`
     (a real focus ring — the tree's existing open-kanban button uses bare
     `focus:outline-none`; that is a pre-existing a11y gap, not precedent to
     copy).

Ghost-button visibility: **always visible but low-contrast**. Hover-reveal
fails touch (mobile drawer renders the same Sidebar) and hides a primary
action in a local-only single-org app; always-visible matches the existing
open-kanban affordance.

### i18n

- Reuse `t('appBar.projects')` for the title (already translated in all 7
  locales).
- Add `sidebar.createProject` to all 7 locales:
  - en `Create project`, es `Crear proyecto`, fr `Créer un projet`,
    ja `プロジェクトを作成`, ko `프로젝트 만들기`, zh-Hans `创建项目`,
    zh-Hant `建立專案`.

### Extensibility / DRY

Future ADR-007 sections (TODO, Notes) compose the same primitive:
`<SidebarSectionHeader title={...} actions={...} />` + their content below,
each with its own `titleId`/`aria-labelledby`. The `actions` slot keeps
counts/badges (future) and buttons (now) uniform without special-casing.

## Consequences

- Positive: the sidebar reads as "Projects — [create +] / [tree]" at a glance;
  project creation gets a discoverable entry point with zero dead code; the
  component is reusable for every future section; styling uses the centralized
  theme tokens (ADR-002); the header is the single a11y label source for the
  tree (no duplicated "Projects, Projects" announcements); the button lives in
  the layer that owns the dialog, keeping packages/ui agnostic.
- Negative: one more slot prop on `Sidebar` (accepted — it is the established
  pattern); uppercase micro-label trades a little raw legibility for the
  conventional scannable header look (standard for section chrome, not body
  text).
- Ongoing: if section headers later need per-section menus or counts, extend
  the `actions` slot rather than the component API.
