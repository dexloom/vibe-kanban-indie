//! Helpers for running interactive agent sessions inside a detached `tmux`
//! session and attaching a terminal emulator to it as a viewer.
//!
//! tmux is the universal session backbone: the agent runs under
//! `tmux new-session -d`, so the session outlives both vibe-kanban and the
//! terminal window. The emulator (iTerm2 / WezTerm / Terminal.app /
//! gnome-terminal / xterm) merely attaches via `tmux attach -t <name>`.

use std::{collections::HashMap, path::Path};

use executors::interactive::TerminalKind;
use thiserror::Error;
use tokio::process::Command;

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
/// `Enter` key itself. `=session` is an exact-match target and `--` ends option
/// parsing so a leading `-` in `text` is not treated as a flag.
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

/// Args for the literal-text `send-keys` call (typed verbatim, no newline).
fn send_keys_literal_args(session_name: &str, text: &str) -> Vec<String> {
    vec![
        "send-keys".to_string(),
        "-t".to_string(),
        format!("={session_name}"),
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
        format!("={session_name}"),
        "Enter".to_string(),
    ]
}

/// Map a `send-keys` failure to `SessionGone` when tmux can't find the session,
/// otherwise to a generic `TmuxFailed`.
fn classify_send_keys_err(session_name: &str, stderr: &[u8]) -> TerminalError {
    let stderr = String::from_utf8_lossy(stderr);
    if stderr.contains("can't find session") || stderr.contains("no server running") {
        TerminalError::SessionGone(session_name.to_string())
    } else {
        TerminalError::TmuxFailed(stderr.trim().to_string())
    }
}

/// Open the chosen terminal emulator attached to the tmux session. For
/// [`TerminalKind::None`] this is a no-op. If the emulator is unavailable,
/// returns [`TerminalError::TerminalUnavailable`] — the caller should keep the
/// detached session and surface the attach command.
pub async fn open_in_terminal(kind: TerminalKind, session_name: &str) -> Result<(), TerminalError> {
    let attach = attach_command(session_name);
    match kind {
        TerminalKind::None => Ok(()),
        TerminalKind::ITerm2 => {
            let script = format!(
                "tell application \"iTerm\"\n\
                 activate\n\
                 create window with default profile command \"{attach}\"\n\
                 end tell"
            );
            run_osascript(kind, &script, &attach).await
        }
        TerminalKind::TerminalApp => {
            let script = format!(
                "tell application \"Terminal\"\n\
                 activate\n\
                 do script \"{attach}\"\n\
                 end tell"
            );
            run_osascript(kind, &script, &attach).await
        }
        TerminalKind::WezTerm => {
            run_emulator(
                kind,
                "wezterm",
                &["start", "--", "tmux", "attach", "-t", session_name],
                &attach,
            )
            .await
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

async fn run_osascript(
    kind: TerminalKind,
    script: &str,
    attach: &str,
) -> Result<(), TerminalError> {
    match Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
    {
        Ok(out) if out.status.success() => Ok(()),
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
                "=vk-abc".to_string(),
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
    fn send_keys_enter_targets_exact_session() {
        assert_eq!(
            send_keys_enter_args("vk-abc"),
            vec![
                "send-keys".to_string(),
                "-t".to_string(),
                "=vk-abc".to_string(),
                "Enter".to_string(),
            ]
        );
    }

    #[test]
    fn classify_send_keys_err_detects_missing_session() {
        let gone = classify_send_keys_err("vk-abc", b"can't find session: vk-abc");
        assert!(matches!(gone, TerminalError::SessionGone(s) if s == "vk-abc"));
        let other = classify_send_keys_err("vk-abc", b"some other tmux error");
        assert!(matches!(other, TerminalError::TmuxFailed(_)));
    }
}
