//! Helpers for running interactive agent sessions inside a detached `tmux`
//! session and attaching a terminal emulator to it as a viewer.
//!
//! tmux is the universal session backbone: the agent runs under
//! `tmux new-session -d`, so the session outlives both vibe-kanban and the
//! terminal window. The emulator (iTerm2 / WezTerm / Terminal.app /
//! gnome-terminal / xterm) merely attaches via `tmux attach -t <name>`.

use std::{collections::HashMap, path::Path, sync::OnceLock};

use executors::interactive::TerminalKind;
use thiserror::Error;
use tokio::{process::Command, sync::Mutex};

/// Process-global slot tracking the iTerm2 window VK reuses for headed-session
/// tabs. `None` means "no VK window yet"; a stored id may also be stale (the
/// user closed the window), in which case the AppleScript falls back to creating
/// a fresh window and reports its id. The [`Mutex`] is held across the
/// `osascript` call so concurrent opens don't each spawn their own window.
fn iterm_window_slot() -> &'static Mutex<Option<i64>> {
    static SLOT: OnceLock<Mutex<Option<i64>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error(
        "tmux is not installed or not on PATH. Install it (macOS: `brew install tmux`, \
         Ubuntu: `sudo apt install tmux`) to use interactive terminal mode."
    )]
    TmuxNotInstalled,
    #[error("tmux command failed: {0}")]
    TmuxFailed(String),
    #[error("tmux session '{0}' is no longer running")]
    SessionGone(String),
    #[error(
        "terminal emulator '{kind:?}' is not available; the tmux session was created — \
         attach manually with: {attach_cmd}"
    )]
    TerminalUnavailable {
        kind: TerminalKind,
        attach_cmd: String,
    },
    #[error("failed to escape tmux command: {0}")]
    Quote(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The command a user can run by hand to attach to the session.
pub fn attach_command(session_name: &str) -> String {
    format!("tmux attach -t {session_name}")
}

/// Whether tmux is available on PATH.
pub async fn tmux_available() -> bool {
    match Command::new("tmux").arg("-V").output().await {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Create a detached tmux session named `session_name` in `cwd`, running the
/// resolved `argv` with the given environment. `env_remove` lists variables to
/// unset inside the session (e.g. `ANTHROPIC_API_KEY` when `disable_api_key`).
///
/// The agent command is composed into a single shell string with `shlex`
/// escaping and an `env …` prefix, because the tmux session does NOT inherit
/// vibe-kanban's per-execution environment the way a child process would.
pub async fn tmux_new_session(
    session_name: &str,
    cwd: &Path,
    argv: &[String],
    env: &HashMap<String, String>,
    env_remove: &[String],
) -> Result<(), TerminalError> {
    let inner = build_inner_command(argv, env, env_remove)?;

    let output = Command::new("tmux")
        .arg("new-session")
        .arg("-d")
        .arg("-s")
        .arg(session_name)
        .arg("-c")
        .arg(cwd)
        .arg(&inner)
        .output()
        .await
        .map_err(map_tmux_io_err)?;

    if !output.status.success() {
        return Err(TerminalError::TmuxFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

/// Build the `env [-u NAME]… KEY=VAL… <argv>` shell string that tmux runs.
fn build_inner_command(
    argv: &[String],
    env: &HashMap<String, String>,
    env_remove: &[String],
) -> Result<String, TerminalError> {
    let mut tokens: Vec<String> = vec!["env".to_string()];
    for key in env_remove {
        tokens.push("-u".to_string());
        tokens.push(key.clone());
    }
    // Sort keys for deterministic output (helps tests + reproducibility).
    let mut keys: Vec<&String> = env.keys().collect();
    keys.sort();
    for key in keys {
        tokens.push(format!("{key}={}", env[key]));
    }
    tokens.extend(argv.iter().cloned());

    shlex::try_join(tokens.iter().map(String::as_str))
        .map_err(|e| TerminalError::Quote(e.to_string()))
}

/// Whether a tmux session with this name currently exists (i.e. is alive).
pub async fn tmux_has_session(session_name: &str) -> bool {
    match Command::new("tmux")
        .arg("has-session")
        .arg("-t")
        .arg(format!("={session_name}")) // exact-match target
        .output()
        .await
    {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Kill a tmux session by name (best effort).
pub async fn tmux_kill_session(session_name: &str) -> Result<(), TerminalError> {
    let output = Command::new("tmux")
        .arg("kill-session")
        .arg("-t")
        .arg(format!("={session_name}"))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    // A non-existent session is not an error for our purposes.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("can't find session") && !stderr.contains("no server running") {
            return Err(TerminalError::TmuxFailed(stderr.trim().to_string()));
        }
    }
    Ok(())
}

/// Send a line of input to the foreground process of `session_name`'s first
/// pane: type `text` literally, then press Enter. Used to answer questions /
/// approve prompts in the agent's interactive TUI from outside the terminal.
///
/// Two `send-keys` calls keep the message and the submitting keystroke
/// unambiguous: the first uses `-l` (literal) so nothing in `text` — `$VAR`,
/// quotes, or key-names like `Enter` — is interpreted; the second sends the
/// `Enter` key itself. `--` ends option parsing so a leading `-` in `text` is not
/// treated as a flag.
///
/// The target is the bare session name (NOT `=name`): for `send-keys` the `-t`
/// target is a *pane*, and the `=` exact-match prefix — valid for
/// `has-session`/`kill-session` — makes tmux report "can't find pane". Session
/// names are unique full UUIDs, so prefix matching resolves to the right pane.
pub async fn tmux_send_keys(session_name: &str, text: &str) -> Result<(), TerminalError> {
    // Type the literal text (no trailing newline).
    let literal = Command::new("tmux")
        .args(send_keys_literal_args(session_name, text))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !literal.status.success() {
        return Err(classify_send_keys_err(session_name, &literal.stderr));
    }

    // Submit with a real Enter keystroke.
    let enter = Command::new("tmux")
        .args(send_keys_enter_args(session_name))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !enter.status.success() {
        return Err(classify_send_keys_err(session_name, &enter.stderr));
    }
    Ok(())
}

/// Submit a full (possibly multi-line) message into `session_name`'s pane as a
/// single bracketed-paste block, then press Enter to send it.
///
/// Unlike [`tmux_send_keys`], a newline inside `text` does NOT submit the message
/// mid-way: the `ESC[200~ … ESC[201~` wrappers tell the TUI to treat the whole
/// block as one paste (the same bytes a real terminal emits when you paste), so a
/// multi-line prompt lands as one input. A separate `Enter` keystroke then
/// submits it. Used to deliver an MCP / orchestrator prompt into a live headed
/// agent without reusing the single-line operator-input guard.
///
/// This relies on the TUI having bracketed-paste mode enabled (Claude Code does);
/// if it is not, the markers would be typed literally.
pub async fn tmux_paste_message(session_name: &str, text: &str) -> Result<(), TerminalError> {
    let wrapped = bracketed_paste(text);
    // Type the wrapped block literally so the ESC bytes reach the pane verbatim.
    let literal = Command::new("tmux")
        .args(send_keys_literal_args(session_name, &wrapped))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !literal.status.success() {
        return Err(classify_send_keys_err(session_name, &literal.stderr));
    }

    // Submit with a real Enter keystroke.
    let enter = Command::new("tmux")
        .args(send_keys_enter_args(session_name))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !enter.status.success() {
        return Err(classify_send_keys_err(session_name, &enter.stderr));
    }
    Ok(())
}

/// Wrap `text` in the bracketed-paste markers a terminal emits around pasted
/// content (`ESC[200~` … `ESC[201~`).
fn bracketed_paste(text: &str) -> String {
    format!("\u{1b}[200~{text}\u{1b}[201~")
}

/// Send a single Enter keystroke to `session_name`'s pane (no typed text).
/// Used to confirm/accept the interactive startup prompts (folder-trust, the
/// dev-channel warning) where the safe option is already the highlighted default.
pub async fn tmux_send_enter(session_name: &str) -> Result<(), TerminalError> {
    let enter = Command::new("tmux")
        .args(send_keys_enter_args(session_name))
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !enter.status.success() {
        return Err(classify_send_keys_err(session_name, &enter.stderr));
    }
    Ok(())
}

/// Capture the visible text of `session_name`'s pane (best-effort snapshot).
/// Used to detect which startup prompt is currently on screen before auto-
/// confirming it. The target is the bare session name (see [`tmux_send_keys`]).
pub async fn tmux_capture_pane(session_name: &str) -> Result<String, TerminalError> {
    let output = Command::new("tmux")
        .args(["capture-pane", "-p", "-t", session_name])
        .output()
        .await
        .map_err(map_tmux_io_err)?;
    if !output.status.success() {
        return Err(classify_send_keys_err(session_name, &output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Args for the literal-text `send-keys` call (typed verbatim, no newline).
fn send_keys_literal_args(session_name: &str, text: &str) -> Vec<String> {
    vec![
        "send-keys".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "-l".to_string(),
        "--".to_string(),
        text.to_string(),
    ]
}

/// Args for the `send-keys ... Enter` call that submits the typed line.
fn send_keys_enter_args(session_name: &str) -> Vec<String> {
    vec![
        "send-keys".to_string(),
        "-t".to_string(),
        session_name.to_string(),
        "Enter".to_string(),
    ]
}

/// Map a `send-keys` failure to `SessionGone` when tmux can't find the session,
/// otherwise to a generic `TmuxFailed`.
fn classify_send_keys_err(session_name: &str, stderr: &[u8]) -> TerminalError {
    let stderr = String::from_utf8_lossy(stderr);
    // A session that exited takes its pane/window with it, so tmux may report any
    // of these — all mean "the interactive session is gone" (→ a clean 409).
    if stderr.contains("can't find session")
        || stderr.contains("can't find pane")
        || stderr.contains("can't find window")
        || stderr.contains("no server running")
    {
        TerminalError::SessionGone(session_name.to_string())
    } else {
        TerminalError::TmuxFailed(stderr.trim().to_string())
    }
}

/// Open the chosen terminal emulator attached to the tmux session. For
/// [`TerminalKind::None`] this is a no-op. If the emulator is unavailable,
/// returns [`TerminalError::TerminalUnavailable`] — the caller should keep the
/// detached session and surface the attach command.
///
/// `title` is the human-readable label shown on the iTerm2 tab/window (e.g. the
/// kanban card id + branch); it is purely cosmetic and distinct from
/// `session_name`, which is the tmux session used to attach.
///
/// `iterm_tabs` only affects [`TerminalKind::ITerm2`]: when true (default),
/// sessions are grouped as tabs of one VK window; when false, each session opens
/// in its own window (the legacy behavior).
pub async fn open_in_terminal(
    kind: TerminalKind,
    session_name: &str,
    title: &str,
    iterm_tabs: bool,
) -> Result<(), TerminalError> {
    let attach = attach_command(session_name);
    match kind {
        TerminalKind::None => Ok(()),
        TerminalKind::ITerm2 => open_iterm_tab(&attach, title, iterm_tabs).await,
        TerminalKind::TerminalApp => {
            let script = build_terminal_app_script(&attach, title);
            run_osascript(kind, &script, &attach).await.map(|_| ())
        }
        TerminalKind::WezTerm => {
            let args = wezterm_attach_args(session_name, title);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            run_emulator(kind, "wezterm", &args, &attach).await
        }
        TerminalKind::GnomeTerminal => {
            run_emulator(
                kind,
                "gnome-terminal",
                &["--", "tmux", "attach", "-t", session_name],
                &attach,
            )
            .await
        }
        TerminalKind::Xterm => {
            run_emulator(
                kind,
                "xterm",
                &["-e", "tmux", "attach", "-t", session_name],
                &attach,
            )
            .await
        }
    }
}

/// Open the attach command in iTerm2. When `group_tabs` is true, reuse the
/// single VK-owned window as a TAB host (creating that window the first time, or
/// whenever the previous one was closed); the lock serializes concurrent opens
/// so they share one window, and the AppleScript returns the id of the window it
/// used, which we remember for the next tab. When false, each call opens a fresh
/// window (the `-1` sentinel skips the lookup) and no id is tracked.
///
/// `title` is set as the tab/session title so grouped tabs (or per-session
/// windows) are distinguishable at a glance.
async fn open_iterm_tab(attach: &str, title: &str, group_tabs: bool) -> Result<(), TerminalError> {
    if !group_tabs {
        // Legacy: a separate window per session, no shared-window tracking.
        let script = build_iterm_tab_script(-1, attach, title);
        run_osascript(TerminalKind::ITerm2, &script, attach).await?;
        return Ok(());
    }
    let slot = iterm_window_slot();
    let mut guard = slot.lock().await;
    let known_id = guard.unwrap_or(-1);
    let script = build_iterm_tab_script(known_id, attach, title);
    let stdout = run_osascript(TerminalKind::ITerm2, &script, attach).await?;
    // osascript prints the script's return value (the window id) on stdout.
    if let Some(id) = stdout
        .lines()
        .next_back()
        .and_then(|line| line.trim().parse::<i64>().ok())
    {
        *guard = Some(id);
    }
    Ok(())
}

/// Build the AppleScript that reuses VK's iTerm window (by `known_id`, or `-1`
/// for "none yet") as a tab host. It finds the window by id; if it's gone (or
/// none is known) it creates a fresh window instead; either way it types the
/// attach command into the new session, titles the session with `title` (so its
/// tab — the "card header" — identifies it), and returns the window id used.
///
/// `write text` (rather than `command "<attach>"`) is deliberate: it runs in a
/// login shell so `tmux` resolves on PATH, and keeps the shell alive after
/// `tmux attach` detaches — see the original single-window rationale.
///
/// Setting `name` pins a manual title on the session so tmux's own title updates
/// don't overwrite it; this is what lets grouped tabs be told apart at a glance.
///
/// We bind the session that `create window`/`create tab` returns into
/// `targetSession` and write into *that*, rather than `current session of
/// targetWindow`. The latter resolves to whichever tab is *selected* when the
/// `write text` runs, so under a focus race (or if VK's window isn't frontmost)
/// the attach command could be typed into an unrelated, already-open tab — the
/// agent would appear "somewhere else" while the freshly created tab stayed a
/// blank shell. Referencing the created session removes that ambiguity.
fn build_iterm_tab_script(known_id: i64, attach: &str, title: &str) -> String {
    let title = applescript_quote(title);
    format!(
        "tell application \"iTerm\"\n\
         activate\n\
         set targetWindow to missing value\n\
         if {known_id} is not -1 then\n\
           repeat with w in windows\n\
             if (id of w) is {known_id} then\n\
               set targetWindow to w\n\
               exit repeat\n\
             end if\n\
           end repeat\n\
         end if\n\
         if targetWindow is missing value then\n\
           set targetWindow to (create window with default profile)\n\
           set targetSession to (current session of targetWindow)\n\
         else\n\
           tell targetWindow\n\
             set newTab to (create tab with default profile)\n\
           end tell\n\
           set targetSession to (current session of newTab)\n\
         end if\n\
         tell targetSession\n\
           write text \"{attach}\"\n\
           set name to \"{title}\"\n\
         end tell\n\
         return id of targetWindow\n\
         end tell"
    )
}

/// Build the AppleScript that opens a Terminal.app tab attached to the session
/// and pins `title` as its custom tab title. `do script` returns the new tab, so
/// `set custom title of` it labels exactly the tab we just created.
fn build_terminal_app_script(attach: &str, title: &str) -> String {
    let title = applescript_quote(title);
    format!(
        "tell application \"Terminal\"\n\
         activate\n\
         set vkTab to do script \"{attach}\"\n\
         set custom title of vkTab to \"{title}\"\n\
         end tell"
    )
}

/// Build the `wezterm start` argv that attaches to the tmux session with `title`
/// as the tab title. WezTerm adopts the OSC-0 title the program emits, so we run
/// a tiny shell that prints the title escape, then `exec`s `tmux attach`. The
/// title and session are passed as positional `$1`/`$2` (never interpolated into
/// the script) so a branch with spaces or shell metacharacters can't break out.
///
/// tmux only rewrites the terminal title when `set-titles` is on (off by
/// default), so the title we set before attaching normally sticks.
fn wezterm_attach_args(session_name: &str, title: &str) -> Vec<String> {
    // `\033]0;<title>\007` is the OSC sequence that sets the window/tab title;
    // `printf` interprets the octal escapes from the single-quoted format.
    let inner = "printf '\\033]0;%s\\007' \"$1\"; exec tmux attach -t \"$2\"";
    ["start", "--", "sh", "-c", inner, "sh", title, session_name]
        .into_iter()
        .map(String::from)
        .collect()
}

/// Escape a string for embedding inside an AppleScript double-quoted literal.
/// Tab titles are a card id + branch name, which can in principle contain a
/// double-quote or backslash, so escape them to keep the generated script
/// well-formed.
fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

async fn run_osascript(
    kind: TerminalKind,
    script: &str,
    attach: &str,
) -> Result<String, TerminalError> {
    match Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
    {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(_) | Err(_) => Err(TerminalError::TerminalUnavailable {
            kind,
            attach_cmd: attach.to_string(),
        }),
    }
}

async fn run_emulator(
    kind: TerminalKind,
    program: &str,
    args: &[&str],
    attach: &str,
) -> Result<(), TerminalError> {
    // Spawn detached: the emulator runs independently of vibe-kanban.
    match Command::new(program).args(args).spawn() {
        Ok(_) => Ok(()),
        Err(_) => Err(TerminalError::TerminalUnavailable {
            kind,
            attach_cmd: attach.to_string(),
        }),
    }
}

fn map_tmux_io_err(e: std::io::Error) -> TerminalError {
    if e.kind() == std::io::ErrorKind::NotFound {
        TerminalError::TmuxNotInstalled
    } else {
        TerminalError::Io(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inner_command_sets_env_and_escapes_prompt() {
        let mut env = HashMap::new();
        env.insert("VK_WORKSPACE_ID".to_string(), "abc 123".to_string());
        env.insert("NPM_CONFIG_LOGLEVEL".to_string(), "error".to_string());
        let argv = vec![
            "/usr/bin/claude".to_string(),
            "--session-id".to_string(),
            "11111111-1111-1111-1111-111111111111".to_string(),
            "fix the $BUG in \"main\"".to_string(),
        ];
        let inner = build_inner_command(&argv, &env, &["ANTHROPIC_API_KEY".to_string()]).unwrap();

        // Unset comes first, env vars are sorted, prompt is quoted/escaped.
        assert!(inner.starts_with("env -u ANTHROPIC_API_KEY "));
        assert!(inner.contains("NPM_CONFIG_LOGLEVEL=error"));
        assert!(inner.contains("'VK_WORKSPACE_ID=abc 123'"));
        // The dangerous prompt must be quoted so $BUG / quotes are not expanded
        // by the shell tmux uses to run the command.
        assert!(inner.contains("'fix the $BUG in \"main\"'"));
        // Round-trips back to the original tokens.
        let parsed = shlex::split(&inner).unwrap();
        assert_eq!(parsed.last().unwrap(), "fix the $BUG in \"main\"");
    }

    #[test]
    fn attach_command_format() {
        assert_eq!(attach_command("vk-x"), "tmux attach -t vk-x");
    }

    #[test]
    fn iterm_tab_script_creates_window_when_none_known() {
        let script = build_iterm_tab_script(-1, "tmux attach -t vk-abc", "vk-abc");
        // With the -1 sentinel the lookup loop is skipped and a fresh window is
        // created; the attach command is typed and the window id is returned.
        assert!(script.contains("if -1 is not -1 then"));
        assert!(script.contains("create window with default profile"));
        // The attach is written into the session we just created (bound), not
        // `current session of targetWindow`, so a focus race can't misroute it.
        assert!(script.contains("set targetSession to (current session of targetWindow)"));
        assert!(script.contains("tell targetSession"));
        assert!(script.contains("write text \"tmux attach -t vk-abc\""));
        assert!(script.contains("return id of targetWindow"));
        // The session is titled after the tmux session so its tab is identifiable.
        assert!(script.contains("set name to \"vk-abc\""));
    }

    #[test]
    fn iterm_tab_script_reuses_known_window_as_tab() {
        let script = build_iterm_tab_script(42, "tmux attach -t vk-def", "vk-def");
        // A known id is matched against open windows; the match path adds a tab
        // rather than a new window.
        assert!(script.contains("if 42 is not -1 then"));
        assert!(script.contains("if (id of w) is 42 then"));
        assert!(script.contains("set newTab to (create tab with default profile)"));
        // The attach targets the session of the tab we just created, so it can't
        // be misrouted to whatever tab happens to be selected at that moment.
        assert!(script.contains("set targetSession to (current session of newTab)"));
        assert!(script.contains("tell targetSession"));
        // The new-window fallback is still present for the stale-id case.
        assert!(script.contains("create window with default profile"));
        // The new tab is titled after its tmux session.
        assert!(script.contains("set name to \"vk-def\""));
    }

    #[test]
    fn terminal_app_script_sets_custom_tab_title() {
        let script = build_terminal_app_script("tmux attach -t vk-abc", "VK-42 feat/login");
        // Opens the attach command and names exactly the tab it just created.
        assert!(script.contains("set vkTab to do script \"tmux attach -t vk-abc\""));
        assert!(script.contains("set custom title of vkTab to \"VK-42 feat/login\""));
    }

    #[test]
    fn wezterm_args_set_title_before_attaching() {
        let args = wezterm_attach_args("vk-abc", "VK-42 feat/login");
        // Launches a GUI window running a shell that sets the OSC title, then
        // execs the attach. Title/session ride as positional args, not inlined.
        assert_eq!(
            args,
            vec![
                "start".to_string(),
                "--".to_string(),
                "sh".to_string(),
                "-c".to_string(),
                "printf '\\033]0;%s\\007' \"$1\"; exec tmux attach -t \"$2\"".to_string(),
                "sh".to_string(),
                "VK-42 feat/login".to_string(),
                "vk-abc".to_string(),
            ]
        );
        // $1 is the title and $2 is the session — order matters.
        assert_eq!(args[args.len() - 2], "VK-42 feat/login");
        assert_eq!(args[args.len() - 1], "vk-abc");
    }

    #[test]
    fn applescript_quote_escapes_quotes_and_backslashes() {
        assert_eq!(applescript_quote("vk-abc"), "vk-abc");
        assert_eq!(applescript_quote("a\"b"), "a\\\"b");
        assert_eq!(applescript_quote("a\\b"), "a\\\\b");
    }

    #[test]
    fn send_keys_literal_passes_text_verbatim() {
        // A tricky payload: a key-name word, a shell var, quotes, a leading dash,
        // and spaces must all be passed as one literal argument so tmux's `-l`
        // types them verbatim instead of interpreting them.
        let text = "-y Enter $X \"quoted\"";
        let args = send_keys_literal_args("vk-abc", text);
        assert_eq!(
            args,
            vec![
                "send-keys".to_string(),
                "-t".to_string(),
                // Bare session name, NOT `=vk-abc`: `=` is invalid as a send-keys
                // pane target ("can't find pane").
                "vk-abc".to_string(),
                "-l".to_string(),
                "--".to_string(),
                text.to_string(),
            ]
        );
        // `--` must precede the payload so a leading `-` is not parsed as a flag.
        let dd = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dd + 1], text);
    }

    #[test]
    fn send_keys_enter_targets_bare_session() {
        assert_eq!(
            send_keys_enter_args("vk-abc"),
            vec![
                "send-keys".to_string(),
                "-t".to_string(),
                "vk-abc".to_string(),
                "Enter".to_string(),
            ]
        );
    }

    #[test]
    fn bracketed_paste_wraps_multiline_as_single_block() {
        let text = "line one\nline two\nline three";
        let wrapped = bracketed_paste(text);
        // Starts/ends with the paste markers...
        assert!(wrapped.starts_with("\u{1b}[200~"));
        assert!(wrapped.ends_with("\u{1b}[201~"));
        // ...and the original (newlines included) is preserved verbatim between
        // them, so the TUI inserts it as one multi-line input rather than
        // submitting on the first newline.
        assert_eq!(wrapped, format!("\u{1b}[200~{text}\u{1b}[201~"));
        assert!(wrapped.contains("line one\nline two\nline three"));
        // The wrapped payload is what gets typed literally (-l) before Enter.
        let args = send_keys_literal_args("vk-abc", &wrapped);
        assert_eq!(args.last().unwrap(), &wrapped);
    }

    #[test]
    fn classify_send_keys_err_detects_missing_session() {
        // A session that exited reports as missing session/pane/window — all gone.
        for stderr in [
            &b"can't find session: vk-abc"[..],
            b"can't find pane: vk-abc",
            b"can't find window: vk-abc",
            b"no server running on /tmp/tmux-501/default",
        ] {
            assert!(
                matches!(
                    classify_send_keys_err("vk-abc", stderr),
                    TerminalError::SessionGone(_)
                ),
                "expected SessionGone for {:?}",
                String::from_utf8_lossy(stderr)
            );
        }
        let other = classify_send_keys_err("vk-abc", b"some other tmux error");
        assert!(matches!(other, TerminalError::TmuxFailed(_)));
    }
}
