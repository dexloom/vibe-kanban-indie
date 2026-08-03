# ADR-010: Sidebar bar buttons — shared primitive + bottom bar (Notifications / Settings)

- **Status**: Accepted
- **Date**: 2026-08-03
- **Relates to**: ADR-009 (bucket bar), ADR-008 (section header), ADR-005 (global sidebar)

## Context

The sidebar now has two horizontal button rows with the same look-and-feel
(icon + small label + optional count badge): the top bucket bar (ADR-009) and
the bottom row (notifications bell, org switcher, user popover, version). The
owner wants:

1. The **top spacing removed** — the bucket-bar buttons must sit at the very
   top of the sidebar (the `p-2` padding + inert Tauri drag strip push them
   down).
2. The bottom row reduced to **Notifications + Settings** (drop the org
   switcher, user popover, and version), styled like the top bar.
3. The bottom buttons **reuse the top-bar button** — do not build a full new
   component per need.

## Decision

### `SidebarBarButton` (packages/ui) — the shared button primitive

Extract the top-bar button's visual (vertical icon + small label + optional
count badge) into one reusable, presentational, ref-forwarding button:

```ts
interface SidebarBarButtonProps {
  label: string;             // visible text under the icon (also accessible name)
  icon: PhosphorIcon;
  iconClass?: string;        // icon color token (bucket bar passes bucket colors)
  badgeCount?: number;       // hidden when <= 0
  badgeClass?: string;
  onClick?: () => void;      // optional; set when the button is NOT a dropdown trigger
  className?: string;        // e.g. `flex-1` on the top bar; natural width on the bottom
  aria-label?: string;       // override accessible name (defaults to label)
}
```

- `flex-1` is **not** baked in — the top bucket bar passes it (three equal
  buttons fill the row); the bottom bar keeps buttons at natural width (owner:
  "same size as now, don't fill free space").
- Count badge via the existing `CountBadge` (`size="sm"`), `aria-hidden`.
- `forwardRef` so it can be a `DropdownMenuTrigger asChild` child.

### `SidebarBucketBar` (refactor)

`BucketButton`'s button visual is replaced by `<SidebarBarButton
className="flex-1" ...>` wrapped in `DropdownMenuTrigger asChild`. All bucket
behavior (dropdown, newest-first, empty state) is unchanged; only the button
markup is shared.

### `Sidebar.tsx` — top spacing + bottom slot

- Remove the inert `h-7` Tauri drag strip and the top padding: aside becomes
  `px-2 pb-2` (macOS window drag is covered by the Navbar drag region; the
  bucket bar now sits flush at the top).
- Drop the `notificationBell` / `organizationsSwitcher` / `userPopover` /
  `appVersion` / `updateVersion` / `onUpdateClick` props. Add a single
  `bottomActions?: ReactNode` slot rendered in the `mt-auto` bottom row
  (same slot pattern as ADR-008's `headerActions`).

### `SidebarBottomBar` (web-core, new)

One small component composing the two bottom buttons from `SidebarBarButton`:

- **Notifications**: `BellIcon`, badge = `useNotifications().unseenCount`,
  onClick → `navigate({ to: '/notifications' })` (same target as the old bell).
- **Settings**: `GearIcon`, onClick → `SettingsDialog.show()` (same entry the
  Navbar already uses).

`SharedAppLayout` passes `bottomActions={<SidebarBottomBar />}` to BOTH the
desktop and mobile-drawer `<Sidebar>` renders (the drawer keeps working; the
old org/user/version props are removed).

### i18n (en only)

Add `sidebar.notifications` ("Notifications") and `sidebar.settings`
("Settings"). The bell/settings buttons show these as visible labels.

## Consequences

- Positive: one button primitive serves every sidebar bar (bucket bar,
  notifications, settings, future sections) — no per-need components; the
  bottom bar keeps the compact footprint (no flex-stretch); the top of the
  sidebar is clean; org-switcher/user/version cruft is gone.
- Negative: dropping the org switcher removes the (synthetic) org affordance —
  the app has a single "Local" org, so this is fine; Windows/Linux lose the
  sidebar's own Tauri drag strip (macOS Navbar covers the top drag region).
- Ongoing: future sidebar actions (refresh, etc.) compose `SidebarBarButton`.
