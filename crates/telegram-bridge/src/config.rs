//! Bridge configuration.
//!
//! Source of truth is `~/.vibe-kanban/telegram.toml` (loaded via
//! `utils::telegram_config`). For backwards compatibility the connection fields
//! still fall back to the original environment variables (`VK_TG_CHAT_ID`,
//! `VK_TG_GENERAL_THREAD_ID`, `TELEGRAM_BOT_TOKEN`), so existing env-driven
//! setups keep working unchanged. Backend address resolution mirrors the
//! MCP/TUI pattern (env first, then the port file the backend writes).

use anyhow::{Context, Result};
use utils::telegram_config::{self, TelegramConfig, TokenSource};

pub struct Config {
    /// `ws://host:port/api`
    pub ws_base: String,
    /// `http://host:port/api`
    pub http_base: String,
    pub bot_token: String,
    pub token_source: TokenSource,
    pub chat_id: String,
    /// Forum thread for non-worktree ("General") messages. Optional.
    pub general_thread_id: Option<i64>,
    /// Per-worktree topic settings (flag, executor list, name template).
    pub telegram: TelegramConfig,
}

impl Config {
    /// Load the bridge configuration. Returns:
    /// - `Ok(Some(_))` to run,
    /// - `Ok(None)` when the integration is disabled or not configured (caller
    ///   should exit cleanly),
    /// - `Err(_)` when configured-but-invalid (missing token/chat id).
    pub async fn load() -> Result<Option<Self>> {
        let file = telegram_config::load();

        // Exit cleanly when explicitly disabled, or when neither the TOML nor
        // the legacy env var provides a chat id (i.e. nothing is configured).
        match &file {
            Some(cfg) if !cfg.enabled => {
                tracing::info!("telegram.toml present but enabled = false; bridge will exit");
                return Ok(None);
            }
            None if env_chat_id().is_none() => {
                tracing::info!(
                    "no telegram.toml and no VK_TG_CHAT_ID; telegram bridge not configured"
                );
                return Ok(None);
            }
            _ => {}
        }

        let chat_id = file
            .as_ref()
            .and_then(|c| c.chat_id.clone())
            .or_else(env_chat_id)
            .context("missing chat id (set chat_id in telegram.toml or VK_TG_CHAT_ID)")?;

        let general_thread_id = file
            .as_ref()
            .and_then(|c| c.general_thread_id.clone())
            .or_else(|| std::env::var("VK_TG_GENERAL_THREAD_ID").ok())
            .and_then(|s| s.trim().parse::<i64>().ok());

        let (bot_token, token_source) = telegram_config::resolve_bot_token(file.as_ref()).context(
            "missing Telegram bot token (set bot_token in telegram.toml, TELEGRAM_BOT_TOKEN, \
             or ~/.claude/channels/telegram/.env)",
        )?;

        let (http_base, ws_base) = resolve_backend().await?;
        let telegram = file.unwrap_or_default();

        Ok(Some(Self {
            ws_base,
            http_base,
            bot_token,
            token_source,
            chat_id,
            general_thread_id,
            telegram,
        }))
    }
}

fn env_chat_id() -> Option<String> {
    std::env::var("VK_TG_CHAT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

async fn resolve_backend() -> Result<(String, String)> {
    if let Ok(url) = std::env::var("VIBE_BACKEND_URL") {
        let url = url.trim_end_matches('/').to_string();
        let ws = http_to_ws(&url);
        return Ok((format!("{url}/api"), format!("{ws}/api")));
    }
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    // `HOST` is a bind address; `0.0.0.0`/`::` are not dialable and the
    // backend's loopback-Host guard rejects them as a Host header.
    let host = utils::net::dialable_host(&host).to_string();
    let port = match std::env::var("BACKEND_PORT").or_else(|_| std::env::var("PORT")) {
        Ok(p) => p.parse::<u16>().context("invalid port")?,
        Err(_) => utils::port_file::read_port_file("vibe-kanban")
            .await
            .context("no port file — is the backend running?")?,
    };
    Ok((
        format!("http://{host}:{port}/api"),
        format!("ws://{host}:{port}/api"),
    ))
}

fn http_to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        url.to_string()
    }
}
