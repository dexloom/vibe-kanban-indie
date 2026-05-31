//! Types describing the interactive (non-headless) terminal mode for coding
//! agents. In this mode the agent runs inside a detached `tmux` session in the
//! task worktree, and a terminal emulator merely attaches to it as a viewer.
//!
//! `TerminalKind` lives in this crate (rather than the services config layer)
//! on purpose: `services` already depends on `executors`, so putting it here
//! lets both `InteractiveTmuxConfig` (executors) and the user `Config`
//! (services) reference it without creating a dependency cycle.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Terminal emulator used to *attach* to the detached tmux session that hosts
/// the interactive agent. The session itself always runs under tmux; the
/// emulator is just a viewer, so it can be changed/closed without affecting the
/// running agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalKind {
    /// macOS iTerm2 (via AppleScript / `osascript`).
    ITerm2,
    /// WezTerm (`wezterm cli spawn` / `wezterm start`), cross-platform.
    WezTerm,
    /// macOS Terminal.app (via AppleScript / `osascript`).
    TerminalApp,
    /// Linux gnome-terminal.
    GnomeTerminal,
    /// Linux xterm.
    Xterm,
    /// Do not open any window; just create the detached tmux session and
    /// surface the `tmux attach` command to the user.
    #[default]
    None,
}

impl TerminalKind {
    /// Reasonable default for the current platform, biased toward an emulator
    /// that is commonly present. Presence detection (and falling back) happens
    /// at launch time; this is only the initial config default.
    pub fn platform_default() -> Self {
        #[cfg(target_os = "macos")]
        {
            TerminalKind::ITerm2
        }
        #[cfg(target_os = "linux")]
        {
            TerminalKind::GnomeTerminal
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            TerminalKind::None
        }
    }
}

/// Per-execution configuration for interactive terminal mode. Persisted inside
/// the `ExecutorAction` JSON (`execution_processes.executor_action`), so it
/// survives restarts with no migration.
///
/// Note there is intentionally no `tmux_session` field: the execution id is
/// only created inside `start_execution`, *after* this action JSON is built, so
/// the tmux session name is derived deterministically from the execution id
/// (`vk-<exec_id>`) at start and reconciliation time instead of being stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct InteractiveTmuxConfig {
    /// Forced Claude session id (`claude --session-id <uuid>` / `--resume
    /// <uuid>`). Generated when the action is built so the caller can display
    /// it and so resume reattaches to the same conversation.
    pub session_uuid: Uuid,
    /// Terminal emulator to attach with, frozen at launch.
    pub terminal: TerminalKind,
}

/// Deterministic tmux session name for an execution. Used identically at start
/// time and restart reconciliation, so nothing about the name needs persisting.
pub fn tmux_session_name(exec_id: Uuid) -> String {
    format!("vk-{exec_id}")
}

/// Encode an absolute working directory into the directory name Claude Code
/// uses under `~/.claude/projects/`. Claude replaces every non-ASCII-alphanumeric
/// character with `-` (so `/`, `.`, `_`, spaces, etc. all become `-`).
///
/// e.g. `/Users/me/.openclaw/work` -> `-Users-me--openclaw-work`.
pub fn claude_project_dir_name(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Full path to the transcript JSONL Claude writes for `session_uuid` running in
/// `cwd`: `<home>/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
pub fn claude_transcript_path(home: &Path, cwd: &Path, session_uuid: Uuid) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(claude_project_dir_name(cwd))
        .join(format!("{session_uuid}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_cwd_like_claude() {
        assert_eq!(
            claude_project_dir_name(Path::new("/Users/eugenevm/VibeCoding/vibe-kanban")),
            "-Users-eugenevm-VibeCoding-vibe-kanban"
        );
        // Dotfiles: leading '/' and '.' both become '-' (the observed double dash).
        assert_eq!(
            claude_project_dir_name(Path::new("/Users/eugenevm/.openclaw/workspace/claude")),
            "-Users-eugenevm--openclaw-workspace-claude"
        );
    }

    #[test]
    fn transcript_path_is_uuid_named() {
        let uuid = Uuid::nil();
        let p = claude_transcript_path(Path::new("/home/me"), Path::new("/work/repo"), uuid);
        assert_eq!(
            p,
            Path::new("/home/me/.claude/projects/-work-repo").join(format!("{uuid}.jsonl"))
        );
    }

    #[test]
    fn tmux_name_is_deterministic() {
        let id = Uuid::nil();
        assert_eq!(tmux_session_name(id), format!("vk-{id}"));
        assert_eq!(tmux_session_name(id), tmux_session_name(id));
    }
}
