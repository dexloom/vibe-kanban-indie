//! Read-only Telegram integration endpoints for the settings UI.
//!
//! The integration itself is configured by hand-editing
//! `~/.vibe-kanban/telegram.toml` and run by the standalone `vibe-telegram-bridge`
//! daemon. These endpoints only let the frontend *observe* that config and send
//! a one-off test message — they never write the TOML and never expose the token.
//!
//! `POST /api/telegram/test` calls `sendMessage` directly from the server. That
//! is safe: only `getUpdates` (long-polling) conflicts across processes, and
//! neither the server nor the bridge ever polls.

use std::time::Duration;

use axum::{
    Router,
    extract::State,
    response::Json as ResponseJson,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use utils::{
    response::ApiResponse,
    telegram::Telegram,
    telegram_config::{self, TokenSource},
};

use crate::{DeploymentImpl, error::ApiError};

/// Heartbeat written by the bridge (`telegram-bridge.status.json`).
#[derive(Deserialize)]
struct BridgeHeartbeat {
    connected: bool,
    last_seen_at: Option<DateTime<Utc>>,
}

const BRIDGE_STALE_AFTER: Duration = Duration::from_secs(30);
const STATUS_FILE: &str = "telegram-bridge.status.json";

#[derive(Debug, Serialize, TS)]
pub struct TelegramStatus {
    /// `enabled = true` in telegram.toml.
    pub enabled: bool,
    /// A chat id and a resolvable bot token are both present.
    pub configured: bool,
    /// Chat id with all but the last 4 chars masked (never the full id in logs).
    pub chat_id_masked: Option<String>,
    pub general_thread_id: Option<String>,
    pub per_worktree_topics: bool,
    /// Where the bot token was resolved from, or `None` if unresolved.
    pub token_source: Option<String>,
    /// The bridge heartbeat is present and recent.
    pub bridge_connected: bool,
    pub bridge_last_seen: Option<String>,
    /// Absolute path of the hand-edited config file (shown in the UI help).
    pub config_path: String,
}

#[derive(Debug, Serialize, TS)]
pub struct TelegramTestResponse {
    pub ok: bool,
    pub error: Option<String>,
}

async fn get_status() -> Result<ResponseJson<ApiResponse<TelegramStatus>>, ApiError> {
    let cfg = telegram_config::load();
    let token = telegram_config::resolve_bot_token(cfg.as_ref());

    let chat_id = telegram_config::resolve_chat_id(cfg.as_ref());
    let configured = chat_id.is_some() && token.is_some();

    let (bridge_connected, bridge_last_seen) = read_heartbeat();

    let status = TelegramStatus {
        enabled: cfg.as_ref().map(|c| c.enabled).unwrap_or(false),
        configured,
        chat_id_masked: chat_id.as_deref().map(mask),
        general_thread_id: telegram_config::resolve_general_thread_id(cfg.as_ref()),
        per_worktree_topics: cfg.as_ref().map(|c| c.per_worktree_topics).unwrap_or(false),
        token_source: token.map(|(_, src)| token_source_label(src).to_string()),
        bridge_connected,
        bridge_last_seen,
        config_path: telegram_config::config_path().to_string_lossy().to_string(),
    };

    Ok(ResponseJson(ApiResponse::success(status)))
}

async fn send_test(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<TelegramTestResponse>>, ApiError> {
    let cfg = telegram_config::load();
    let Some((token, _)) = telegram_config::resolve_bot_token(cfg.as_ref()) else {
        return Ok(ResponseJson(ApiResponse::success(TelegramTestResponse {
            ok: false,
            error: Some("No bot token configured".to_string()),
        })));
    };
    let Some(chat_id) = telegram_config::resolve_chat_id(cfg.as_ref()) else {
        return Ok(ResponseJson(ApiResponse::success(TelegramTestResponse {
            ok: false,
            error: Some(
                "No chat_id configured (set chat_id in telegram.toml or VK_TG_CHAT_ID)".to_string(),
            ),
        })));
    };

    let thread = telegram_config::resolve_general_thread_id(cfg.as_ref())
        .and_then(|s| s.trim().parse::<i64>().ok());

    let telegram = Telegram::new(token, chat_id);
    let result = telegram
        .send_message("✅ vibe-kanban test message", thread)
        .await;

    deployment
        .track_if_analytics_allowed(
            "telegram_test_sent",
            serde_json::json!({ "ok": result.is_ok() }),
        )
        .await;

    let response = match result {
        Ok(()) => TelegramTestResponse {
            ok: true,
            error: None,
        },
        Err(e) => TelegramTestResponse {
            ok: false,
            error: Some(e.to_string()),
        },
    };
    Ok(ResponseJson(ApiResponse::success(response)))
}

/// Read the bridge heartbeat file; returns (connected, last_seen_rfc3339).
fn read_heartbeat() -> (bool, Option<String>) {
    let path = telegram_config::state_dir().join(STATUS_FILE);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (false, None);
    };
    let Ok(hb) = serde_json::from_str::<BridgeHeartbeat>(&raw) else {
        return (false, None);
    };
    let last_seen = hb.last_seen_at;
    let recent = last_seen
        .map(|ts| {
            Utc::now()
                .signed_duration_since(ts)
                .to_std()
                .map(|d| d < BRIDGE_STALE_AFTER)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    (hb.connected && recent, last_seen.map(|ts| ts.to_rfc3339()))
}

fn token_source_label(src: TokenSource) -> &'static str {
    src.as_str()
}

/// Mask a chat id to its last 4 characters, e.g. `-1001234567890` → `···7890`.
fn mask(value: &str) -> String {
    let n = value.chars().count();
    if n <= 4 {
        return "···".to_string();
    }
    let tail: String = value.chars().skip(n - 4).collect();
    format!("···{tail}")
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/telegram/status", get(get_status))
        .route("/telegram/test", post(send_test))
}
