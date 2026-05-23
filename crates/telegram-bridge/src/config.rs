//! Bridge configuration: backend address, Telegram bot token, and the target
//! supergroup. Resolution mirrors the MCP/TUI pattern (env first, then the
//! port file the backend writes).

use std::path::PathBuf;

use anyhow::{Context, Result};

pub struct Config {
    /// `ws://host:port/api`
    pub ws_base: String,
    /// `http://host:port/api` (for future REST lookups, e.g. per-task topics)
    #[allow(dead_code)]
    pub http_base: String,
    pub bot_token: String,
    pub chat_id: String,
    /// Forum thread to mirror everything into (the "General" topic). Optional.
    pub general_thread_id: Option<String>,
}

impl Config {
    pub async fn load() -> Result<Self> {
        let (http_base, ws_base) = resolve_backend().await?;
        let bot_token = load_bot_token().context(
            "missing Telegram bot token (set TELEGRAM_BOT_TOKEN or \
             ~/.claude/channels/telegram/.env)",
        )?;
        let chat_id = std::env::var("VK_TG_CHAT_ID")
            .context("missing VK_TG_CHAT_ID (the supergroup chat id)")?;
        let general_thread_id = std::env::var("VK_TG_GENERAL_THREAD_ID").ok();
        Ok(Self {
            ws_base,
            http_base,
            bot_token,
            chat_id,
            general_thread_id,
        })
    }
}

async fn resolve_backend() -> Result<(String, String)> {
    if let Ok(url) = std::env::var("VIBE_BACKEND_URL") {
        let url = url.trim_end_matches('/').to_string();
        let ws = http_to_ws(&url);
        return Ok((format!("{url}/api"), format!("{ws}/api")));
    }
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
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

/// Read the bot token from `TELEGRAM_BOT_TOKEN`, else the same `.env` file the
/// sombrax-telegram listener uses.
fn load_bot_token() -> Result<String> {
    if let Ok(t) = std::env::var("TELEGRAM_BOT_TOKEN")
        && !t.trim().is_empty()
    {
        return Ok(t.trim().to_string());
    }
    let path = token_env_path();
    let contents =
        std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    for line in contents.lines() {
        if let Some(rest) = line.trim().strip_prefix("TELEGRAM_BOT_TOKEN=") {
            let v = rest.trim().trim_matches('"').to_string();
            if !v.is_empty() {
                return Ok(v);
            }
        }
    }
    anyhow::bail!("TELEGRAM_BOT_TOKEN not found in {}", path.display())
}

fn token_env_path() -> PathBuf {
    if let Ok(p) = std::env::var("TELEGRAM_ENV_FILE") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".claude/channels/telegram/.env")
}
