//! Per-worktree forum topics.
//!
//! When `per_worktree_topics` is enabled, each worktree (workspace) whose agent
//! is one of `topic_executors` (Claude Code by default) gets its own Telegram
//! forum topic. Escalations for that worktree are routed into its topic instead
//! of the General area.
//!
//! Routing is keyed on `execution_process_id` (what approvals carry). We resolve
//! `exec → session → workspace` over the backend's local REST API; the daemon
//! reaches these endpoints directly since the local backend is unauthenticated.
//! The `workspace_id → message_thread_id` map is persisted under
//! `~/.vibe-kanban` so a bridge restart reuses existing topics instead of
//! creating duplicates.

use std::{collections::HashMap, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use utils::{
    telegram::Telegram,
    telegram_config::{self, TelegramConfig},
};
use uuid::Uuid;

const MAP_FILE: &str = "telegram-topics.json";

/// Minimal mirrors of the backend REST payloads we read (`ApiResponse<T>`).
#[derive(Deserialize)]
struct ApiEnvelope<T> {
    data: Option<T>,
}

#[derive(Deserialize)]
struct ExecProcessDto {
    session_id: Uuid,
}

#[derive(Deserialize)]
struct SessionDto {
    workspace_id: Uuid,
    executor: Option<String>,
}

#[derive(Deserialize)]
struct WorkspaceDto {
    branch: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct TopicMap {
    /// workspace_id → message_thread_id
    workspaces: HashMap<Uuid, i64>,
}

pub struct Topics {
    telegram: Telegram,
    http: reqwest::Client,
    http_base: String,
    cfg: TelegramConfig,
    map_path: PathBuf,
    map: Arc<Mutex<TopicMap>>,
    /// execution_process_id → workspace_id (in-memory resolver cache).
    exec_workspace: Arc<Mutex<HashMap<Uuid, Uuid>>>,
}

impl Topics {
    pub fn new(telegram: Telegram, http_base: String, cfg: TelegramConfig) -> Self {
        let map_path = telegram_config::state_dir().join(MAP_FILE);
        let map = load_map(&map_path);
        Self {
            telegram,
            http: reqwest::Client::new(),
            http_base,
            cfg,
            map_path,
            map: Arc::new(Mutex::new(map)),
            exec_workspace: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn per_worktree_enabled(&self) -> bool {
        self.cfg.per_worktree_topics
    }

    /// Ensure a topic exists for the worktree owning `exec_id` (creating it on
    /// first sight), and return its thread id. Returns `None` when the feature
    /// is off, the worktree's executor isn't opted in, or resolution fails — in
    /// which case the caller falls back to the General area.
    pub async fn thread_for_exec(&self, exec_id: Uuid) -> Option<i64> {
        if !self.cfg.per_worktree_topics {
            return None;
        }
        match self.ensure_topic(exec_id).await {
            Ok(thread) => thread,
            Err(e) => {
                tracing::warn!("topic resolution failed for exec {exec_id}: {e}");
                None
            }
        }
    }

    /// React to an execution-process insert from the events stream: proactively
    /// create the worktree's topic so it appears at agent start, before any
    /// approval is raised.
    pub async fn on_execution_process_created(&self, exec_id: Uuid) {
        let _ = self.thread_for_exec(exec_id).await;
    }

    /// React to a workspace removal: close its topic (best-effort) and drop the
    /// mapping.
    pub async fn on_workspace_removed(&self, workspace_id: Uuid) {
        let thread = {
            let mut map = self.map.lock().await;
            map.workspaces.remove(&workspace_id)
        };
        if let Some(thread) = thread {
            if let Err(e) = self.telegram.close_forum_topic(thread).await {
                tracing::debug!("closeForumTopic failed for {workspace_id}: {e}");
            }
            self.persist().await;
        }
    }

    async fn ensure_topic(&self, exec_id: Uuid) -> Result<Option<i64>> {
        let workspace_id = self.resolve_workspace_id(exec_id).await?;

        // Fast path: already have a topic for this worktree.
        if let Some(thread) = self.map.lock().await.workspaces.get(&workspace_id).copied() {
            return Ok(Some(thread));
        }

        // Need the session's executor + workspace branch/name to decide + name.
        let session = self.get_session_for_exec(exec_id).await?;
        let executor = session.executor.unwrap_or_default();
        if !self.cfg.executor_gets_topic(&executor) {
            return Ok(None);
        }
        let workspace = self.get_workspace(workspace_id).await?;

        // Re-check under lock to avoid a duplicate create on concurrent calls.
        {
            let map = self.map.lock().await;
            if let Some(thread) = map.workspaces.get(&workspace_id).copied() {
                return Ok(Some(thread));
            }
        }

        let name = self
            .cfg
            .topic_name(workspace.name.as_deref(), &workspace.branch);
        let thread = self
            .telegram
            .create_forum_topic(&name)
            .await
            .with_context(|| format!("createForumTopic '{name}'"))?;

        self.map
            .lock()
            .await
            .workspaces
            .insert(workspace_id, thread);
        self.persist().await;

        let _ = self
            .telegram
            .send_message(
                &format!("🧵 worktree topic for {name}\nbranch: {}", workspace.branch),
                Some(thread),
            )
            .await;

        tracing::info!("created topic {thread} for worktree {workspace_id} ({name})");
        Ok(Some(thread))
    }

    async fn resolve_workspace_id(&self, exec_id: Uuid) -> Result<Uuid> {
        if let Some(ws) = self.exec_workspace.lock().await.get(&exec_id).copied() {
            return Ok(ws);
        }
        let session = self.get_session_for_exec(exec_id).await?;
        self.exec_workspace
            .lock()
            .await
            .insert(exec_id, session.workspace_id);
        Ok(session.workspace_id)
    }

    async fn get_session_for_exec(&self, exec_id: Uuid) -> Result<SessionDto> {
        let exec: ExecProcessDto = self
            .get(&format!("/execution-processes/{exec_id}"))
            .await
            .context("GET execution-process")?;
        self.get(&format!("/sessions/{}", exec.session_id))
            .await
            .context("GET session")
    }

    async fn get_workspace(&self, workspace_id: Uuid) -> Result<WorkspaceDto> {
        self.get(&format!("/workspaces/{workspace_id}"))
            .await
            .context("GET workspace")
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let url = format!("{}{path}", self.http_base);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .with_context(|| format!("request {url}"))?;
        let env: ApiEnvelope<T> = resp.json().await.context("decode response")?;
        env.data.context("response had no data")
    }

    async fn persist(&self) {
        let map = self.map.lock().await;
        if let Err(e) = write_map(&self.map_path, &map) {
            tracing::warn!("failed to persist {}: {e}", self.map_path.display());
        }
    }
}

fn load_map(path: &PathBuf) -> TopicMap {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => TopicMap::default(),
    }
}

fn write_map(path: &PathBuf, map: &TopicMap) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(map).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(path, json)
}
