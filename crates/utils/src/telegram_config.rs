//! TOML-based Telegram orchestration config, shared by the server (for the
//! status/test endpoints) and the `vibe-telegram-bridge` daemon.
//!
//! The file is the source of truth for the local Telegram integration. It lives
//! at `~/.vibe-kanban/telegram.toml` (mirroring `projects.toml`), and is
//! hand-edited — there is no UI writer. Resolution honours
//! `$VIBE_KANBAN_TELEGRAM_CONFIG`, then `~/.vibe-kanban/telegram.toml`, then
//! `<asset_dir>/telegram.toml`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The executor string stored on a session when Claude Code is the agent
/// (`BaseCodingAgent::ClaudeCode` serialises to SCREAMING_SNAKE_CASE).
pub const CLAUDE_CODE_EXECUTOR: &str = "CLAUDE_CODE";

fn default_topic_executors() -> Vec<String> {
    vec![CLAUDE_CODE_EXECUTOR.to_string()]
}

/// Shape of `telegram.toml`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramConfig {
    /// Master on/off for the bridge. When false the daemon exits cleanly.
    #[serde(default)]
    pub enabled: bool,
    /// Bot token. Optional here: falls back to `TELEGRAM_BOT_TOKEN`, then
    /// `~/.claude/channels/telegram/.env` (see [`resolve_bot_token`]).
    #[serde(default)]
    pub bot_token: Option<String>,
    /// Target supergroup (forum) chat id, e.g. `-1001234567890`.
    #[serde(default)]
    pub chat_id: Option<String>,
    /// Forum thread to mirror non-worktree messages into (the "General" topic).
    #[serde(default)]
    pub general_thread_id: Option<String>,
    /// Spawn a dedicated forum topic per worktree whose agent is in
    /// [`Self::topic_executors`].
    #[serde(default)]
    pub per_worktree_topics: bool,
    /// Executors (session `executor` strings) that get a per-worktree topic.
    /// Defaults to `["CLAUDE_CODE"]`.
    #[serde(default = "default_topic_executors")]
    pub topic_executors: Vec<String>,
    /// Topic name template; `{name}` / `{branch}` are substituted. Defaults to
    /// `"vk: {name}"`.
    #[serde(default)]
    pub topic_name_template: Option<String>,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bot_token: None,
            chat_id: None,
            general_thread_id: None,
            per_worktree_topics: false,
            topic_executors: default_topic_executors(),
            topic_name_template: None,
        }
    }
}

impl TelegramConfig {
    /// Render a topic name for a worktree from the template.
    pub fn topic_name(&self, name: Option<&str>, branch: &str) -> String {
        let template = self.topic_name_template.as_deref().unwrap_or("vk: {name}");
        let display = name.filter(|n| !n.is_empty()).unwrap_or(branch);
        template
            .replace("{name}", display)
            .replace("{branch}", branch)
    }

    /// Whether the given session `executor` string should get its own topic.
    pub fn executor_gets_topic(&self, executor: &str) -> bool {
        self.per_worktree_topics && self.topic_executors.iter().any(|e| e == executor)
    }
}

/// Resolve the config file path: `$VIBE_KANBAN_TELEGRAM_CONFIG`, otherwise
/// `~/.vibe-kanban/telegram.toml` (falling back to `<asset_dir>/telegram.toml`
/// only if the home directory can't be determined).
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("VIBE_KANBAN_TELEGRAM_CONFIG")
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .map(|home| home.join(".vibe-kanban"))
        .unwrap_or_else(crate::assets::asset_dir)
        .join("telegram.toml")
}

/// The directory state files (topic map, heartbeat) live in, alongside the
/// config: `~/.vibe-kanban` (or `<asset_dir>` as a fallback).
pub fn state_dir() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".vibe-kanban"))
        .unwrap_or_else(crate::assets::asset_dir)
}

/// Load `telegram.toml`. Returns `None` if the file is absent or unparseable
/// (the error is logged), so callers can treat "no config" as "disabled".
pub fn load() -> Option<TelegramConfig> {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => {
            tracing::debug!("No telegram.toml at {}", path.display());
            return None;
        }
    };
    match toml::from_str::<TelegramConfig>(&raw) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            tracing::warn!("Failed to parse {}: {e}", path.display());
            None
        }
    }
}

/// Where a bot token came from — surfaced (without the secret) in the status UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    Toml,
    Env,
    EnvFile,
}

impl TokenSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            TokenSource::Toml => "telegram.toml",
            TokenSource::Env => "TELEGRAM_BOT_TOKEN",
            TokenSource::EnvFile => "~/.claude/channels/telegram/.env",
        }
    }
}

/// Resolve the bot token: the TOML value, else `TELEGRAM_BOT_TOKEN`, else the
/// `TELEGRAM_BOT_TOKEN=` line in `~/.claude/channels/telegram/.env` (overridable
/// via `TELEGRAM_ENV_FILE`). Returns the token and where it came from.
pub fn resolve_bot_token(cfg: Option<&TelegramConfig>) -> Option<(String, TokenSource)> {
    if let Some(t) = cfg.and_then(|c| c.bot_token.as_deref())
        && !t.trim().is_empty()
    {
        return Some((t.trim().to_string(), TokenSource::Toml));
    }
    if let Ok(t) = std::env::var("TELEGRAM_BOT_TOKEN")
        && !t.trim().is_empty()
    {
        return Some((t.trim().to_string(), TokenSource::Env));
    }
    let path = token_env_path();
    let contents = std::fs::read_to_string(&path).ok()?;
    for line in contents.lines() {
        if let Some(rest) = line.trim().strip_prefix("TELEGRAM_BOT_TOKEN=") {
            let v = rest.trim().trim_matches('"').to_string();
            if !v.is_empty() {
                return Some((v, TokenSource::EnvFile));
            }
        }
    }
    None
}

fn token_env_path() -> PathBuf {
    if let Ok(p) = std::env::var("TELEGRAM_ENV_FILE") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude/channels/telegram/.env")
}

/// Resolve the chat id: the TOML value, else the legacy `VK_TG_CHAT_ID` env var.
/// The bridge honors the same fallback, so status/test reporting stays in sync
/// with whether the bridge is actually configured.
pub fn resolve_chat_id(cfg: Option<&TelegramConfig>) -> Option<String> {
    if let Some(id) = cfg.and_then(|c| c.chat_id.as_deref())
        && !id.trim().is_empty()
    {
        return Some(id.trim().to_string());
    }
    std::env::var("VK_TG_CHAT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the general thread id: the TOML value, else `VK_TG_GENERAL_THREAD_ID`.
pub fn resolve_general_thread_id(cfg: Option<&TelegramConfig>) -> Option<String> {
    if let Some(id) = cfg.and_then(|c| c.general_thread_id.as_deref())
        && !id.trim().is_empty()
    {
        return Some(id.trim().to_string());
    }
    std::env::var("VK_TG_GENERAL_THREAD_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_name_substitutes_name_then_branch() {
        let cfg = TelegramConfig::default();
        assert_eq!(cfg.topic_name(Some("Build auth"), "br-1"), "vk: Build auth");
        // Falls back to branch when name is empty/None.
        assert_eq!(cfg.topic_name(None, "br-1"), "vk: br-1");
        assert_eq!(cfg.topic_name(Some(""), "br-1"), "vk: br-1");
    }

    #[test]
    fn topic_name_custom_template() {
        let cfg = TelegramConfig {
            topic_name_template: Some("[{branch}] {name}".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.topic_name(Some("Task"), "feat/x"), "[feat/x] Task");
    }

    #[test]
    fn executor_gets_topic_respects_flag_and_list() {
        let mut cfg = TelegramConfig {
            per_worktree_topics: true,
            ..Default::default()
        };
        assert!(cfg.executor_gets_topic("CLAUDE_CODE"));
        assert!(!cfg.executor_gets_topic("CODEX"));
        cfg.per_worktree_topics = false;
        assert!(!cfg.executor_gets_topic("CLAUDE_CODE"));
    }

    #[test]
    fn parses_minimal_toml() {
        let cfg: TelegramConfig = toml::from_str(
            r#"
            enabled = true
            chat_id = "-100123"
            per_worktree_topics = true
        "#,
        )
        .unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.chat_id.as_deref(), Some("-100123"));
        assert!(cfg.per_worktree_topics);
        // Default executor list applied.
        assert_eq!(cfg.topic_executors, vec!["CLAUDE_CODE".to_string()]);
    }
}
