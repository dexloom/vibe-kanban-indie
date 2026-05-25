//! vibe-kanban → Telegram bridge.
//!
//! A send-only daemon: it subscribes to the backend's approvals stream and posts
//! an escalation to Telegram whenever a coding agent blocks waiting for a
//! decision, so a human (or the PM agent) can unblock it remotely. Each message
//! carries a machine-readable `‹vk …›` footer the PM agent parses to call the
//! `respond_to_approval` MCP tool.
//!
//! With `per_worktree_topics` enabled (in `~/.vibe-kanban/telegram.toml`), each
//! Claude Code worktree gets its own forum topic and its escalations are routed
//! there; everything else goes to the General area.
//!
//! Per the architecture (Design A), the bridge never reads Telegram and never
//! polls the bot token — inbound/control flows through the PM agent (the
//! sombrax-telegram listener client).

mod approvals;
mod config;
mod heartbeat;
mod topics;

use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::Result;
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::Message;
use tracing_subscriber::EnvFilter;
use utils::{log_msg::LogMsg, telegram::Telegram};

use crate::{
    approvals::{ApprovalEvent, format_escalation, parse_patch},
    config::Config,
    heartbeat::Heartbeat,
    topics::Topics,
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

    let Some(config) = Config::load().await? else {
        // Disabled or not configured — nothing to do.
        return Ok(());
    };
    tracing::info!(
        "bridge: backend {} → telegram chat {} (token via {}, per-worktree topics: {})",
        config.ws_base,
        config.chat_id,
        config.token_source.as_str(),
        config.telegram.per_worktree_topics,
    );

    let telegram = Telegram::new(config.bot_token.clone(), config.chat_id.clone());
    let general_thread = config.general_thread_id;

    if let Err(e) = telegram
        .send_message("🟢 vibe-kanban bridge connected", general_thread)
        .await
    {
        tracing::warn!("startup ping failed (check token/chat_id): {e}");
    }

    let topics = Arc::new(Topics::new(
        telegram.clone(),
        config.http_base.clone(),
        config.telegram.clone(),
    ));

    let heartbeat = Heartbeat::new(config.chat_id.clone(), config.telegram.per_worktree_topics);
    heartbeat.spawn();

    // Proactively spawn worktree topics from the events stream (best-effort,
    // reconnecting). Only needed when the feature is on.
    if topics.per_worktree_enabled() {
        let events_url = format!("{}/events", config.http_base);
        let topics_for_events = topics.clone();
        tokio::spawn(async move {
            run_events(&events_url, topics_for_events).await;
        });
    }

    run_approvals(&config, &telegram, general_thread, topics, heartbeat).await
}

/// Subscribe to the approvals stream, reconnecting with backoff. `seen` survives
/// reconnects so a re-delivered snapshot doesn't re-post existing approvals.
async fn run_approvals(
    config: &Config,
    telegram: &Telegram,
    general_thread: Option<i64>,
    topics: Arc<Topics>,
    heartbeat: Heartbeat,
) -> Result<()> {
    let ws_url = format!("{}/approvals/stream/ws", config.ws_base);
    let mut seen: HashSet<String> = HashSet::new();
    let mut backoff = Duration::from_secs(1);

    loop {
        match consume_approvals(&ws_url, telegram, general_thread, &topics, &mut seen).await {
            Ok(()) => {
                tracing::warn!("approvals stream ended; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                tracing::warn!("approvals stream error: {e}; retrying in {:?}", backoff);
            }
        }
        heartbeat.set_connected(false);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn consume_approvals(
    ws_url: &str,
    telegram: &Telegram,
    general_thread: Option<i64>,
    topics: &Arc<Topics>,
    seen: &mut HashSet<String>,
) -> Result<()> {
    let (mut socket, _) = tokio_tungstenite::connect_async(ws_url).await?;
    tracing::info!("approvals stream connected");
    while let Some(msg) = socket.next().await {
        match msg? {
            Message::Text(text) => {
                if let Some(patch) = decode_patch(text.as_str()) {
                    for event in parse_patch(&patch) {
                        handle_event(event, telegram, general_thread, topics, seen).await;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

async fn handle_event(
    event: ApprovalEvent,
    telegram: &Telegram,
    general_thread: Option<i64>,
    topics: &Arc<Topics>,
    seen: &mut HashSet<String>,
) {
    match event {
        // Post any approval we haven't seen yet (covers both fresh `Created`
        // events and any pending present at first connect). Mark it `seen` only
        // after a successful send, so a transient Telegram failure is retried on
        // the next snapshot/reconnect rather than suppressed forever.
        ApprovalEvent::Snapshot(infos) => {
            for info in infos {
                if seen.contains(&info.approval_id) {
                    continue;
                }
                let thread = route(topics, info.execution_process_id, general_thread).await;
                if post(telegram, &format_escalation(&info), thread).await {
                    seen.insert(info.approval_id);
                }
            }
        }
        ApprovalEvent::Created(info) => {
            if seen.contains(&info.approval_id) {
                return;
            }
            let thread = route(topics, info.execution_process_id, general_thread).await;
            if post(telegram, &format_escalation(&info), thread).await {
                seen.insert(info.approval_id);
            }
        }
        ApprovalEvent::Resolved(id) => {
            if seen.remove(&id) {
                // Informational; failure here is not retried. Resolution events
                // don't carry the exec id, so they go to General.
                let _ = post(telegram, &format!("✅ resolved · {id}"), general_thread).await;
            }
        }
    }
}

/// Pick the worktree topic for an escalation, falling back to the General area.
async fn route(
    topics: &Arc<Topics>,
    exec_id: uuid::Uuid,
    general_thread: Option<i64>,
) -> Option<i64> {
    match topics.thread_for_exec(exec_id).await {
        Some(thread) => Some(thread),
        None => general_thread,
    }
}

/// Returns true on a successful send.
async fn post(telegram: &Telegram, text: &str, thread: Option<i64>) -> bool {
    match telegram.send_message(text, thread).await {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!("telegram send failed: {e}");
            false
        }
    }
}

/// Consume the backend events SSE stream, driving proactive topic creation.
/// Reconnects with backoff; failures are non-fatal.
async fn run_events(events_url: &str, topics: Arc<Topics>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match consume_events(events_url, &topics).await {
            Ok(()) => backoff = Duration::from_secs(1),
            Err(e) => tracing::warn!("events stream error: {e}; retrying in {:?}", backoff),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

async fn consume_events(events_url: &str, topics: &Arc<Topics>) -> Result<()> {
    let resp = reqwest::Client::new()
        .get(events_url)
        .header("Accept", "text/event-stream")
        .send()
        .await?
        .error_for_status()?;
    tracing::info!("events stream connected");

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        // SSE events are separated by blank lines; process complete lines.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            if let Some(data) = line.strip_prefix("data:")
                && let Some(patch) = decode_patch(data.trim())
            {
                handle_events_patch(&patch, topics).await;
            }
        }
    }
    Ok(())
}

/// Extract execution-process inserts and workspace removals from an events patch.
async fn handle_events_patch(patch: &json_patch::Patch, topics: &Arc<Topics>) {
    use json_patch::PatchOperation;
    for op in &patch.0 {
        match op {
            PatchOperation::Add(a) => {
                if let Some(exec_id) = exec_id_from_path(a.path.as_str()) {
                    topics.on_execution_process_created(exec_id).await;
                }
            }
            PatchOperation::Remove(r) => {
                if let Some(ws_id) = workspace_id_from_path(r.path.as_str()) {
                    topics.on_workspace_removed(ws_id).await;
                }
            }
            _ => {}
        }
    }
}

fn exec_id_from_path(path: &str) -> Option<uuid::Uuid> {
    path.strip_prefix("/execution_processes/")
        .filter(|rest| !rest.contains('/'))
        .and_then(|id| id.parse().ok())
}

fn workspace_id_from_path(path: &str) -> Option<uuid::Uuid> {
    path.strip_prefix("/workspaces/")
        .filter(|rest| !rest.contains('/'))
        .and_then(|id| id.parse().ok())
}

/// Decode a WS/SSE text frame into a JSON-Patch, ignoring the `Ready`/`finished`
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
