# SPEC — Headed agent: "open terminal" flag + fix iTerm tab name (vk/ad68-headed-agent-ter)

## Problem statement

The **Claude Code Headed** executor runs the agent inside a **detached tmux
session** and then attaches a terminal emulator (iTerm2 on this machine) as a
viewer. Two things are missing / wrong:

1. **No control over whether a terminal window opens.** Every headed launch
   pops open an iTerm window/tab. There is no per-agent way to say "start the
   agent but *don't* open a window — just leave it running in a background tmux
   session I can attach to later." The only existing lever is the **global**
   `terminal` config set to `None`, which is not per-agent and also throws away
   the emulator choice for every other headed run.

2. **The iTerm tab is labelled "tmux" instead of the card/workspace name.**
   When a headed session opens, the iTerm tab title reads `tmux` rather than the
   kanban card (e.g. `VIBE-42 Fix login`). The code already *computes* the right
   title and calls iTerm's `set name`, but iTerm still shows `tmux` (see root
   cause below).

This card adds a per-agent **"Open terminal window"** flag and makes the iTerm
tab reliably show the card/workspace name.

## Goals

- Add a per-headed-agent boolean flag that controls whether a terminal emulator
  window is opened automatically when a headed session starts. Default **on**
  (preserves today's behavior).
- When the flag is **off**: the detached tmux session is still created and the
  agent runs normally in the background; **no** emulator window is opened. The
  attach command (`tmux attach -t vk-<exec_id>`) is surfaced in the server log
  (as it already is) so the operator can attach on demand later.
- Make the iTerm2 tab/window for a headed session show the **card name**
  (`<simple_id> <title>`), falling back to the branch, then the tmux session
  name — the exact string `interactive_tab_title` already produces — instead of
  `tmux`.

## Non-goals

- No change to the **headless** Claude path or any non-Claude executor.
- No change to the two **explicit** "open a terminal" user actions (the *Open
  terminal* button `open_interactive_terminal` and the *Claude resume* button
  `open_claude_resume_terminal`): those exist precisely to pop a window on
  demand, so they always open regardless of the new flag. (They *do* benefit
  from the tab-name fix, since they share the same AppleScript.)
- No new global config field; the flag lives on the headed agent config, next to
  the existing `telegram_channel` / `local_binary` flags.
- Not reworking the tmux session **name** (`vk-<exec_id>`) — it is the attach
  target and must stay deterministic. Only the tmux *window name* / terminal
  *title* changes.

## Background — current behavior & key files

- **Headed executor config:** `crates/executors/src/executors/claude.rs` —
  `ClaudeCodeHeaded` (line ~785) flattens `ClaudeCode` and adds
  `telegram_channel: Option<bool>` and `local_binary: Option<bool>`, each with a
  `#[schemars(title, description)]` annotation. Those annotations are what render
  the checkboxes in the agent-config UI (the form is generated from
  `shared/schemas/claude_code_headed.json`). Helper methods
  `telegram_channel_enabled()` / `local_binary_enabled()` read them with
  defaults.
- **Spawn orchestration:** `crates/local-deployment/src/container.rs`
  - `start_detached_tmux` (line ~1410): builds argv/env, creates the detached
    tmux session (`tmux_new_session`, line ~1585), then **always** opens the
    emulator at line ~1600–1607:
    ```rust
    let iterm_tabs = self.config.read().await.iterm_tabs;
    let tab_title = self.interactive_tab_title(exec_id, &tmux_session).await;
    terminal::open_in_terminal(cfg.terminal, &tmux_session, &tab_title, iterm_tabs).await
    ```
    This handles **both** initial and follow-up headed runs. **This is the only
    automatic-open site the new flag gates.**
  - The `CodingAgent::ClaudeCodeHeaded(cch)` arm (line ~1460) is where headed
    flags are read (`telegram_channel_enabled()`, `local_binary_enabled()`); the
    new flag is read here too.
  - `interactive_tab_title` (line ~1644): already resolves the linked card to
    `"<simple_id> <title>"`, else the branch, else the passed fallback (the tmux
    session name).
  - `open_interactive_terminal` (line ~2540) and `open_claude_resume_terminal`
    (line ~2584): explicit user-triggered opens — **not** gated by the flag.
- **Terminal launch:** `crates/local-deployment/src/terminal.rs`
  - `tmux_new_session` (line ~80): `tmux new-session -d -s <name> -c <cwd>
    <inner>`.
  - `open_in_terminal` (line ~325) → for iTerm2, `open_iterm_tab` (line ~493) →
    `build_iterm_tab_script` (line ~536): the AppleScript that types
    `tmux attach -t <session>` into a session and does `set name to "<title>"`.
- **Interactive types:** `crates/executors/src/interactive.rs` — `TerminalKind`
  enum (incl. `None` = "don't open a window; just create the detached session"),
  `InteractiveTmuxConfig { session_uuid, terminal }`, and
  `tmux_session_name(exec_id) -> "vk-<exec_id>"`.
- **Where `cfg.terminal` comes from:** `crates/services/src/services/container.rs`
  (line ~1350) builds `InteractiveTmuxConfig { terminal: config.terminal }` for
  headed initial runs.

### Root cause of the "tmux" tab name

`build_iterm_tab_script` sets the iTerm2 **session name** (`set name to
"<title>"`). But the *displayed* tab title in iTerm2 follows the **terminal-set
title** / job. When the login shell runs `tmux attach`, the shell's own
preexec/title hook emits an OSC title escape (`ESC]0;tmux BEL`) — literally the
job word `tmux` — and iTerm shows that. tmux, with its default `set-titles
off`, does **not** re-assert the terminal title afterwards, so `tmux` sticks.
`set name` is either not what the user's profile displays, or is overridden by
that escape.

Evidence this is a title-escape issue: the *other* emulators already work around
exactly this — the WezTerm path (`wezterm_attach_args`, line ~590) emits an
OSC-0 title escape (`printf '\033]0;%s\007'`) before `exec tmux attach`, and
Terminal.app uses `set custom title` (a hard override). Only the iTerm path
relies on `set name`, which the shell's escape defeats.

## Requirements & design

### R1 — "Open terminal window" flag on the headed agent

**Data model.** Add to `ClaudeCodeHeaded` (`claude.rs`) a **non-optional `bool`
with a serde default of `true`** (deliberately *not* `Option<bool>` — see the UI
note below):

```rust
fn default_open_terminal() -> bool { true }

/// Open a terminal-emulator window attached to the session when a headed run
/// starts. When disabled, the agent still runs in a detached tmux session
/// (attach later with `tmux attach -t vk-<id>`) but no window is opened.
#[serde(default = "default_open_terminal")]
#[schemars(
    title = "Open terminal window",
    description = "Open a terminal window attached to the session on start. When off, the agent runs in a background tmux session you can attach to later."
)]
pub open_terminal: bool,
```

with a helper for call-site symmetry:

```rust
/// Whether to open a terminal window on headed start. Defaults to `true`.
pub fn open_terminal_enabled(&self) -> bool {
    self.open_terminal
}
```

**Why `bool` + serde default, not `Option<bool>`.** The existing
`telegram_channel` / `local_binary` flags are `Option<bool>` with a backend
`unwrap_or(...)` default, and their generated schema carries **no** `default`.
As a result the RJSF checkbox (`checked = Boolean(value)`,
`packages/web-core/src/shared/dialogs/settings/settings/rjsf/Widgets.tsx`)
renders **unchecked** for an unset field even though the backend treats it as on
— a confusing "unchecked box that still acts on." This card explicitly requires
the box to be **default-checked**. schemars emits `#[serde(default = "…")]`
values into the JSON schema (proven: `append_prompt` uses `#[serde(default)]`
and its schema shows `"default": null`). A `bool` field defaulting to `true`
therefore produces `"default": true` in `claude_code_headed.json`, RJSF merges
that into `formData` (the form is fed `formData={value || {}}` and applies schema
defaults), and the checkbox renders **checked**. It also removes the tri-state
(`null` / `true` / `false`) ambiguity: the field is always a concrete bool. A
missing field on an existing stored profile deserializes to `true` via the serde
default, so no migration and full backward compatibility.

**Wiring.** In `start_detached_tmux` (`container.rs`), read the flag in the
`ClaudeCodeHeaded` arm alongside `telegram_channel` and thread a
`open_terminal: bool` out of the `match` (the `ClaudeCode` arm — a non-headed
executor reaching this path — defaults to `true`). At the open site (line
~1600–1607), gate the emulator open:

```rust
if open_terminal {
    let iterm_tabs = self.config.read().await.iterm_tabs;
    let tab_title = self.interactive_tab_title(exec_id, &tmux_session).await;
    if let Err(e) = terminal::open_in_terminal(cfg.terminal, &tmux_session, &tab_title, iterm_tabs).await {
        tracing::warn!("Could not open terminal emulator for {tmux_session}: {e}");
    }
} else {
    tracing::info!(
        "headed session {tmux_session} started detached (open_terminal=off); attach with `{}`",
        terminal::attach_command(&tmux_session)
    );
}
```

Notes:
- The flag gates **only** the automatic open in `start_detached_tmux` (covers
  both initial and follow-up). The explicit *Open terminal* /
  *Claude resume* buttons are unchanged.
- The Telegram auto-confirm (`auto_confirm_headed_startup`) operates on the tmux
  pane via `send-keys`/`capture-pane`, independent of any attached emulator, so
  a detached (flag-off) session with `telegram_channel` on still auto-confirms
  its startup prompts correctly. No change needed there.
- Interaction with the global `terminal = None` config: if `cfg.terminal` is
  already `None`, `open_in_terminal` is a no-op — so flag-on + `None` behaves as
  today (no window). Flag-off short-circuits before that. Both converge on "no
  window," which is correct.

### R2 — iTerm tab shows the card/workspace name

**Approach (recommended): make tmux own the terminal title.** Because the
`tmux` label is the shell's title escape and tmux by default doesn't re-assert
the title, the fix is to have tmux continuously assert the card name:

For the iTerm attach path (in `terminal.rs`, at/adjacent to `open_iterm_tab`,
before running the AppleScript), apply per-session tmux options against the
target session:

- `tmux set-option -t <session> set-titles on`
- `tmux set-option -t <session> set-titles-string "<title>"` — emit the card
  name as the outer terminal title. A **literal** string (not `#W`) is used so
  tmux's automatic window-renaming can never revert it to the job name.
- `tmux set-window-option -t <session> automatic-rename off`
- `tmux rename-window -t <session> "<title>"` — bonus: `tmux ls` / the status
  line also show the card name (automatic-rename is off so it sticks).

With `set-titles on`, tmux emits `ESC]0;<title>ESC\` (and refreshes it), so it
overrides the shell's one-shot `tmux` escape and iTerm displays the card name. This is shell- and profile-independent (it targets the *terminal-set
title*, which is exactly what iTerm was already showing as `tmux`). Keep the
existing AppleScript `set name to "<title>"` as belt-and-suspenders for profiles
configured to display the session name.

The `<title>` string is the same value already computed by
`interactive_tab_title` and passed into `open_in_terminal`.

**Empirical validation required.** The precise tmux option incantation and
whether `set name` remains necessary will be **verified by actually running the
osascript + tmux commands against iTerm2 on this macOS machine** during
implementation (both a live agent session and, ideally, the *Open terminal*
button path). If tmux `set-titles` proves insufficient or undesirable, the
fallback is the WezTerm-style approach applied to iTerm: write
`printf '\033]0;<title>\007'; tmux attach -t <session>` into the session (title
passed as a positional arg to avoid AppleScript/shell-escaping issues) — but
note the tmux-owned-title approach is preferred because it survives tmux
redraws and keeps the current "shell stays alive after detach" behavior of the
iTerm path.

**Scope of the title fix.** Applying the tmux options in the shared iTerm attach
path fixes the tab name for the automatic open **and** the explicit *Open
terminal* / *Claude resume* buttons (they all funnel through `open_in_terminal`
→ iTerm). This is desirable.

## Affected files

- `crates/executors/src/executors/claude.rs` — add `open_terminal` field +
  `open_terminal_enabled()` to `ClaudeCodeHeaded`; unit test for the default.
- `crates/local-deployment/src/container.rs` — read the flag in
  `start_detached_tmux`, gate the automatic emulator open, log the attach
  command when detached.
- `crates/local-deployment/src/terminal.rs` — assert tmux-owned title
  (rename-window + set-titles) in the iTerm attach path; helper + unit tests for
  the command construction; keep `set name`.
- `shared/schemas/claude_code_headed.json` and `shared/types.ts` — **generated**;
  regenerate via `pnpm run generate-types` (do not hand-edit).

No DB migration and no config-version bump: the field lives inside the
executor-profile JSON, which is schemaless w.r.t. the DB, and defaults keep old
profiles valid.

## Acceptance criteria

1. In the agent-config UI for **Claude Code Headed**, a new **"Open terminal
   window"** checkbox appears (default checked), alongside the existing Telegram
   / local-binary options.
2. With the box **checked** (or unset), starting a headed agent opens an iTerm
   window/tab as before.
3. With the box **unchecked**, starting a headed agent opens **no** window; the
   agent still runs — `tmux has-session -t vk-<exec_id>` succeeds, the transcript
   streams in the web UI, and follow-ups work. The server log shows the attach
   command.
4. When an iTerm tab **does** open for a headed session, its title shows the
   card name (`<simple_id> <title>`), or the branch / session name per the
   existing fallback order — **not** `tmux`. Verified live on iTerm2.
5. The explicit *Open terminal* and *Claude resume* buttons still open a window
   even when the flag is off, and their tabs are also correctly titled.
6. `pnpm run check`, `pnpm run generate-types:check`, `cargo test --workspace`,
   and `pnpm run lint` pass; `pnpm run format` applied.

## Testing / verification

- **Unit (Rust):**
  - `open_terminal_enabled()` defaults to `true` when `None`, honors
    `Some(false)` / `Some(true)`.
  - `terminal.rs`: the new title-assertion helper builds the expected
    `tmux rename-window` / `set-option` argv (pure-function test, no shell-out),
    with a title containing spaces.
- **Type generation:** `pnpm run generate-types` produces the `open_terminal`
  field in `shared/types.ts` and `claude_code_headed.json`;
  `generate-types:check` is clean in CI.
- **Manual, on this macOS machine (has iTerm2 + tmux):**
  - Flag **on** → iTerm tab opens and reads the card name (screenshot / visual).
  - Flag **off** → no window; `tmux ls` shows the `vk-<id>` session; the web
    transcript updates; `tmux attach -t vk-<id>` reveals the running agent.
  - Confirm `set-titles` incantation empirically before finalizing R2.

## Risks & open questions

- **iTerm profile variance:** the tmux `set-titles` fix assumes iTerm displays
  the terminal-set title (which the `tmux` symptom confirms for the user's
  profile). Mitigation: keep `set name` too; validate empirically.
- **Per-session tmux option timing:** `set-option -t <session>` must run against
  an existing session; it's applied after `tmux_new_session` / before/at attach.
  For the resume button the target is the `vk-resume-*` session. Ensure the
  helper is invoked for each session the iTerm path attaches to.
- **Non-iTerm emulators:** WezTerm and Terminal.app already title correctly, so
  the R2 change is scoped to the iTerm branch to avoid regressing them. tmux
  `set-titles` only affects the outer title when a client is attached, so it is
  harmless for the `None` (headless-viewer) case.
