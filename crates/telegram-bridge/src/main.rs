//! vibe-kanban → Telegram bridge.
//!
//! A send-only daemon: it subscribes to the backend's approvals stream and posts
//! an escalation to Telegram whenever a coding agent blocks waiting for a
//! decision, so a human (or the PM agent) can unblock it remotely. Each message
//! carries a machine-readable `‹vk …›` footer the PM agent parses to call the
//! `respond_to_approval` MCP tool.
//!
//! Per the architecture (Design A), the bridge never reads Telegram and never
//! polls the bot token — inbound/control flows through the PM agent (the
//! sombrax-telegram listener client). See the plan at
//! `~/.claude/plans/ethereal-crafting-lemon.md`.

mod approvals;
mod config;
mod telegram;

use std::{collections::HashSet, time::Duration};

use anyhow::Result;
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;
use tracing_subscriber::EnvFilter;
use utils::log_msg::LogMsg;

use crate::{
    approvals::{ApprovalEvent, format_escalation, parse_patch},
    config::Config,
    telegram::Telegram,
};

#[tokio::main]
async fn main() -> Result<()> {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let config = Config::load().await?;
    tracing::info!(
        "bridge: backend {} → telegram chat {}",
        config.ws_base,
        config.chat_id
    );
    let telegram = Telegram::new(
        config.bot_token.clone(),
        config.chat_id.clone(),
        config.general_thread_id.clone(),
    );

    if let Err(e) = telegram.send("🟢 vibe-kanban bridge connected").await {
        tracing::warn!("startup ping failed (check token/chat_id): {e}");
    }

    run(&config, &telegram).await
}

/// Subscribe to the approvals stream, reconnecting with backoff. `seen` survives
/// reconnects so a re-delivered snapshot doesn't re-post existing approvals.
async fn run(config: &Config, telegram: &Telegram) -> Result<()> {
    let ws_url = format!("{}/approvals/stream/ws", config.ws_base);
    let mut seen: HashSet<String> = HashSet::new();
    let mut backoff = Duration::from_secs(1);

    loop {
        match consume_stream(&ws_url, telegram, &mut seen).await {
            Ok(()) => {
                tracing::warn!("approvals stream ended; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                tracing::warn!("approvals stream error: {e}; retrying in {:?}", backoff);
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn consume_stream(
    ws_url: &str,
    telegram: &Telegram,
    seen: &mut HashSet<String>,
) -> Result<()> {
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await?;
    tracing::info!("approvals stream connected");
    while let Some(msg) = socket.next().await {
        match msg? {
            Message::Text(text) => {
                if let Some(patch) = decode_patch(text.as_str()) {
                    for event in parse_patch(&patch) {
                        handle_event(event, telegram, seen).await;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

async fn handle_event(event: ApprovalEvent, telegram: &Telegram, seen: &mut HashSet<String>) {
    match event {
        // Post any approval we haven't seen yet (covers both fresh `Created`
        // events and any pending present at first connect). Mark it `seen` only
        // after a successful send, so a transient Telegram failure is retried on
        // the next snapshot/reconnect rather than suppressed forever.
        ApprovalEvent::Snapshot(infos) => {
            for info in infos {
                if !seen.contains(&info.approval_id)
                    && post(telegram, &format_escalation(&info)).await
                {
                    seen.insert(info.approval_id);
                }
            }
        }
        ApprovalEvent::Created(info) => {
            if !seen.contains(&info.approval_id) && post(telegram, &format_escalation(&info)).await
            {
                seen.insert(info.approval_id);
            }
        }
        ApprovalEvent::Resolved(id) => {
            if seen.remove(&id) {
                // Informational; failure here is not retried.
                let _ = post(telegram, &format!("✅ resolved · {id}")).await;
            }
        }
    }
}

/// Returns true on a successful send.
async fn post(telegram: &Telegram, text: &str) -> bool {
    match telegram.send(text).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("telegram send failed: {e}");
            false
        }
    }
}

/// Decode a WS text frame into a JSON-Patch, ignoring the `Ready`/`finished`
/// sentinels and other `LogMsg` variants.
fn decode_patch(text: &str) -> Option<json_patch::Patch> {
    let trimmed = text.trim();
    if trimmed == r#"{"Ready":true}"# || trimmed == r#"{"finished":true}"# {
        return None;
    }
    match serde_json::from_str::<LogMsg>(text) {
        Ok(LogMsg::JsonPatch(p)) => Some(p),
        _ => None,
    }
}
