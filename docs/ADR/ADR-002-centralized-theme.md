# ADR-002: Centralized theme — CSS custom properties bridged into Tailwind

- **Status**: Accepted
- **Date**: 2026-08-02

## Context

The web UI was hard to read and visually inconsistent:

- Base font shrunk to 87.5% and the type scale was tiny (`text-base` was 12px).
- The Tailwind config (`packages/local-web/tailwind.new.config.js`) mapped only a subset
  of the CSS custom properties defined in `packages/web-core/src/app/styles/new/index.css`,
  so ~15 shadcn-style tokens (`primary-foreground`, `muted-foreground`, `accent`,
  `popover`, `card`, `destructive-*`, `input`, `ring`, `tertiary`, …) generated **no CSS**
  — ~270 class usages were silent visual bugs (e.g. the default Button rendered as a
  transparent box, dialogs invisible against the page in dark mode).
- The `bg-primary` token was semantically overloaded: ~50 usages meant "canvas surface"
  and ~6 meant "primary action".
- Corner radius was ~2px (`--_radius: 0.125rem`), contributing to the "boxy" look.

## Decision

Keep the theme **centralized** in the CSS-variable token layer and complete the bridge
into Tailwind:

1. **Token bridge**: add the missing shadcn-style color entries to
   `tailwind.new.config.js`, each mapping to an existing CSS var
   (`'muted-foreground': 'hsl(var(--muted-foreground))'`, etc.). Zero CSS-value change —
   this fixes the silently-broken classes.
2. **New surface/text namespace**: `canvas / surface / sunken / overlay` and
   `strong / default / muted / subtle`, defined as aliases of existing values, with legacy
   aliases (`primary`, `secondary`, `panel`, `high`, `normal`, `low`) preserved so old
   classes keep working.
3. **`bg-primary` stays canvas** — it is NOT flipped to brand (avoids a flag-day refactor
   of 50 call sites). The six "primary action" components were rewritten to use
   `bg-brand text-on-brand` / `bg-surface` / `bg-overlay` instead.
4. **Readable type scale**: root font 100% (removed `font-size: 87.5%`), `text-base` 16px,
   a `micro`/`2xs`/`xs`/`sm`/`lg`/`xl`/`2xl` scale, 4px spacing grid, and an explicit
   radius scale (6–10px).
5. Components fixed in the same pass: `Button`, `Select`, `KeyboardDialog`, kanban card,
   `AppBar` (`text-[9px]` literals → `text-micro`).

## Consequences

- Positive: one source of truth (CSS vars in `:root`/`.dark`) drives the whole UI; the
  light/dark palettes and CRT theme variants (`packages/public/themes/*.css`) still
  override the same vars; default components render correctly.
- Negative: larger text reduces density slightly (accepted for legibility); alpha
  modifiers (`bg-x/20`) silently drop opacity because the vars lack `<alpha-value>`
  placeholders — tracked as a known limitation for a future sweep.
- Ongoing: theme variants must keep overriding the legacy aliases (new namespaces fall
  back to `:root` in themed runs until each variant file is updated).
