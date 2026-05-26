//! Liveness heartbeat.
//!
//! The bridge runs as a separate process, so the server can't observe it
//! directly. We drop a small status file under `~/.vibe-kanban` and refresh its
//! `last_seen_at` periodically; the server's `/api/telegram/status` endpoint
//! reads it to report whether the bridge is running.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use utils::telegram_config;

const STATUS_FILE: &str = "telegram-bridge.status.json";

#[derive(Serialize)]
struct Status {
    connected: bool,
    chat_id: String,
    per_worktree_topics: bool,
    last_seen_at: String,
}

#[derive(Clone)]
pub struct Heartbeat {
    connected: Arc<AtomicBool>,
    chat_id: String,
    per_worktree_topics: bool,
    path: PathBuf,
}

impl Heartbeat {
    pub fn new(chat_id: String, per_worktree_topics: bool) -> Self {
        Self {
            connected: Arc::new(AtomicBool::new(false)),
            chat_id,
            per_worktree_topics,
            path: telegram_config::state_dir().join(STATUS_FILE),
        }
    }

    /// Reflect the approvals-stream connection state.
    pub fn set_connected(&self, connected: bool) {
        self.connected.store(connected, Ordering::Relaxed);
        self.write();
    }

    /// Spawn a ticker that refreshes `last_seen_at` so the server can tell the
    /// daemon is alive even between connection state changes.
    pub fn spawn(&self) {
        let hb = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(10));
            loop {
                tick.tick().await;
                hb.write();
            }
        });
    }

    fn write(&self) {
        let status = Status {
            connected: self.connected.load(Ordering::Relaxed),
            chat_id: self.chat_id.clone(),
            per_worktree_topics: self.per_worktree_topics,
            last_seen_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&status) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}
