use chrono::{DateTime, Utc};
use executors::actions::{ExecutorAction, ExecutorActionType};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;

/// Maximum length for auto-generated workspace names (derived from first user prompt)
const WORKSPACE_NAME_MAX_LEN: usize = 60;

use super::{
    execution_process::ExecutorActionField,
    session::Session,
    workspace_repo::{RepoWithTargetBranch, WorkspaceRepo},
};

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error("Workspace not found")]
    WorkspaceNotFound,
    #[error("Validation error: {0}")]
    ValidationError(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
}

/// Discriminator for special-purpose workspaces. `None` (NULL) = normal
/// workspace. Lets the UI badge and detect a running orchestrator without
/// name-prefix hacks.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum WorkspaceKind {
    /// Headed Claude Code session driving the board via `/loop`.
    Orchestrator,
    /// Recurring/scheduled task session, repo-independent, running from a
    /// fixed `~/.vibe-kanban/recurrent/<slug>` directory.
    Recurrent,
}

impl WorkspaceKind {
    /// Kinds that run from a fixed on-demand directory instead of a git
    /// worktree, and are therefore NOT board/kanban cards (never reaped as
    /// throwaway worktrees, never listed as cards). Add future no-worktree
    /// kinds here — the SQL card-exclusion filters compare against the
    /// matching lowercase literals (keep them in sync; a test asserts it).
    pub const NON_CARD: &'static [WorkspaceKind] =
        &[WorkspaceKind::Orchestrator, WorkspaceKind::Recurrent];

    /// True if this kind runs from a fixed dir (no git worktree).
    pub fn is_no_worktree(self) -> bool {
        Self::NON_CARD.contains(&self)
    }

    /// The lowercase discriminator string as stored in SQL / serialized.
    pub fn as_sql_str(self) -> &'static str {
        match self {
            WorkspaceKind::Orchestrator => "orchestrator",
            WorkspaceKind::Recurrent => "recurrent",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerInfo {
    pub workspace_id: Uuid,
}

#[derive(Debug)]
struct WorkspaceContainerRefRow {
    id: Uuid,
    container_ref: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Workspace {
    pub id: Uuid,
    pub task_id: Option<Uuid>,
    pub container_ref: Option<String>,
    pub branch: String,
    pub setup_completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub archived: bool,
    pub pinned: bool,
    pub name: Option<String>,
    pub worktree_deleted: bool,
    /// Throwaway workspace (e.g. spec-intake generation). Excluded from list/
    /// kanban queries and event streams; skips normal finalize side effects;
    /// reaped on startup.
    pub ephemeral: bool,
    /// Discriminator for special-purpose workspaces. `None` = normal workspace.
    pub kind: Option<WorkspaceKind>,
    /// Which numbered `## Pipeline` stage the execution agent last reported
    /// itself as starting (1-based), detected from a `VK-PIPELINE-STAGE: N`
    /// marker in the execution's raw log stream. `None` when no coding-agent
    /// execution has reported a stage yet for the current run.
    pub current_pipeline_stage: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct WorkspaceWithStatus {
    #[serde(flatten)]
    #[ts(flatten)]
    pub workspace: Workspace,
    pub is_running: bool,
    pub is_errored: bool,
}

impl std::ops::Deref for WorkspaceWithStatus {
    type Target = Workspace;
    fn deref(&self) -> &Self::Target {
        &self.workspace
    }
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateFollowUpAttempt {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceContext {
    pub workspace: Workspace,
    pub workspace_repos: Vec<RepoWithTargetBranch>,
    pub orchestrator_session_id: Option<Uuid>,
}

#[derive(Debug, Deserialize, TS)]
pub struct CreateWorkspace {
    pub branch: String,
    pub name: Option<String>,
    pub kind: Option<WorkspaceKind>,
}

impl Workspace {
    /// Fetch all workspaces. Newest first.
    pub async fn fetch_all(pool: &SqlitePool) -> Result<Vec<Self>, WorkspaceError> {
        let workspaces = sqlx::query_as!(
            Workspace,
            r#"SELECT id AS "id!: Uuid",
                          task_id AS "task_id: Uuid",
                          container_ref,
                          branch,
                          setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                          created_at AS "created_at!: DateTime<Utc>",
                          updated_at AS "updated_at!: DateTime<Utc>",
                          archived AS "archived!: bool",
                          pinned AS "pinned!: bool",
                          name,
                          worktree_deleted AS "worktree_deleted!: bool",
                          ephemeral AS "ephemeral!: bool",
                          kind AS "kind: WorkspaceKind",
                          current_pipeline_stage
                   FROM workspaces
                   ORDER BY created_at DESC"#
        )
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)?;

        Ok(workspaces)
    }

    /// Load full workspace context by workspace ID.
    pub async fn load_context(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<WorkspaceContext, WorkspaceError> {
        let workspace = Workspace::find_by_id(pool, workspace_id)
            .await?
            .ok_or(WorkspaceError::WorkspaceNotFound)?;

        let workspace_repos =
            WorkspaceRepo::find_repos_with_target_branch_for_workspace(pool, workspace_id).await?;
        let orchestrator_session_id = Session::find_first_by_workspace_id(pool, workspace_id)
            .await?
            .map(|session| session.id);

        Ok(WorkspaceContext {
            workspace,
            workspace_repos,
            orchestrator_session_id,
        })
    }

    /// Update container reference
    pub async fn update_container_ref(
        pool: &SqlitePool,
        workspace_id: Uuid,
        container_ref: &str,
    ) -> Result<(), sqlx::Error> {
        let now = Utc::now();
        sqlx::query!(
            "UPDATE workspaces SET container_ref = $1, updated_at = $2 WHERE id = $3",
            container_ref,
            now,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn mark_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = TRUE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn clear_worktree_deleted(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET worktree_deleted = FALSE, updated_at = datetime('now') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update the workspace's updated_at timestamp to prevent cleanup.
    /// Call this when the workspace is accessed (e.g., opened in editor).
    pub async fn touch(pool: &SqlitePool, workspace_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET updated_at = datetime('now', 'subsec') WHERE id = ?",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       kind              AS "kind: WorkspaceKind",
                       current_pipeline_stage
               FROM    workspaces
               WHERE   id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_rowid(pool: &SqlitePool, rowid: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       kind              AS "kind: WorkspaceKind",
                       current_pipeline_stage
               FROM    workspaces
               WHERE   rowid = $1"#,
            rowid
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn container_ref_exists(
        pool: &SqlitePool,
        container_ref: &str,
    ) -> Result<bool, sqlx::Error> {
        let result = sqlx::query!(
            r#"SELECT EXISTS(SELECT 1 FROM workspaces WHERE container_ref = ?) as "exists!: bool""#,
            container_ref
        )
        .fetch_one(pool)
        .await?;

        Ok(result.exists)
    }

    /// Find workspaces that are expired and eligible for cleanup.
    /// Uses accelerated cleanup (1 hour) for archived workspaces.
    /// Uses standard cleanup (72 hours) for non-archived workspaces.
    pub async fn find_expired_for_cleanup(
        pool: &SqlitePool,
    ) -> Result<Vec<Workspace>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"
            SELECT
                w.id as "id!: Uuid",
                w.task_id as "task_id: Uuid",
                w.container_ref,
                w.branch as "branch!",
                w.setup_completed_at as "setup_completed_at: DateTime<Utc>",
                w.created_at as "created_at!: DateTime<Utc>",
                w.updated_at as "updated_at!: DateTime<Utc>",
                w.archived as "archived!: bool",
                w.pinned as "pinned!: bool",
                w.name,
                w.worktree_deleted as "worktree_deleted!: bool",
                w.ephemeral as "ephemeral!: bool",
                w.kind as "kind: WorkspaceKind",
                w.current_pipeline_stage
            FROM workspaces w
            LEFT JOIN sessions s ON w.id = s.workspace_id
            LEFT JOIN execution_processes ep ON s.id = ep.session_id AND ep.completed_at IS NOT NULL
            WHERE w.container_ref IS NOT NULL
                AND w.worktree_deleted = FALSE
                -- Never reap non-card workspaces (orchestrator, recurrent, …): their
                -- container_ref is a fixed ~/.vibe-kanban/... folder, not a throwaway
                -- worktree. Keep this list in sync with WorkspaceKind::NON_CARD.
                AND (w.kind IS NULL OR w.kind NOT IN ('orchestrator', 'recurrent'))
                AND w.id NOT IN (
                    SELECT DISTINCT s2.workspace_id
                    FROM sessions s2
                    JOIN execution_processes ep2 ON s2.id = ep2.session_id
                    WHERE ep2.completed_at IS NULL
                )
            GROUP BY w.id, w.container_ref, w.updated_at
            HAVING datetime('now', 'localtime',
                CASE
                    WHEN w.archived = 1
                    THEN '-1 hours'
                    ELSE '-72 hours'
                END
            ) > datetime(
                MAX(
                    max(
                        datetime(w.updated_at),
                        datetime(ep.completed_at)
                    )
                )
            )
            ORDER BY MAX(
                CASE
                    WHEN ep.completed_at IS NOT NULL THEN ep.completed_at
                    ELSE w.updated_at
                END
            ) ASC
            "#
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name, kind)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool", ephemeral as "ephemeral!: bool", kind as "kind: WorkspaceKind", current_pipeline_stage"#,
            id,
            Option::<Uuid>::None,
            Option::<String>::None,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name,
            data.kind
        )
        .fetch_one(pool)
        .await?)
    }

    /// Create a throwaway (ephemeral) workspace, e.g. for spec-intake spec
    /// generation. Excluded from list/kanban queries and event streams; reaped
    /// on startup. Normal workspace creation must never set this.
    pub async fn create_ephemeral(
        pool: &SqlitePool,
        data: &CreateWorkspace,
        id: Uuid,
    ) -> Result<Self, WorkspaceError> {
        Ok(sqlx::query_as!(
            Workspace,
            r#"INSERT INTO workspaces (id, task_id, container_ref, branch, setup_completed_at, name, ephemeral)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE)
               RETURNING id as "id!: Uuid", task_id as "task_id: Uuid", container_ref, branch, setup_completed_at as "setup_completed_at: DateTime<Utc>", created_at as "created_at!: DateTime<Utc>", updated_at as "updated_at!: DateTime<Utc>", archived as "archived!: bool", pinned as "pinned!: bool", name, worktree_deleted as "worktree_deleted!: bool", ephemeral as "ephemeral!: bool", kind as "kind: WorkspaceKind", current_pipeline_stage"#,
            id,
            Option::<Uuid>::None,
            Option::<String>::None,
            data.branch,
            Option::<DateTime<Utc>>::None,
            data.name
        )
        .fetch_one(pool)
        .await?)
    }

    /// Find all ephemeral workspaces (used by the startup reaper).
    pub async fn find_ephemeral(pool: &SqlitePool) -> Result<Vec<Self>, WorkspaceError> {
        let workspaces = sqlx::query_as!(
            Workspace,
            r#"SELECT id AS "id!: Uuid",
                      task_id AS "task_id: Uuid",
                      container_ref,
                      branch,
                      setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                      created_at AS "created_at!: DateTime<Utc>",
                      updated_at AS "updated_at!: DateTime<Utc>",
                      archived AS "archived!: bool",
                      pinned AS "pinned!: bool",
                      name,
                      worktree_deleted AS "worktree_deleted!: bool",
                      ephemeral AS "ephemeral!: bool",
                      kind AS "kind: WorkspaceKind",
                      current_pipeline_stage
               FROM workspaces
               WHERE ephemeral = TRUE"#
        )
        .fetch_all(pool)
        .await
        .map_err(WorkspaceError::Database)?;

        Ok(workspaces)
    }

    /// Find the singleton orchestrator workspace (non-archived), if any.
    /// Newest first as a tie-break, though at most one should ever be active.
    pub async fn find_orchestrator(pool: &SqlitePool) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       kind              AS "kind: WorkspaceKind",
                       current_pipeline_stage
               FROM    workspaces
               WHERE   kind = 'orchestrator' AND archived = FALSE
               ORDER BY created_at DESC
               LIMIT 1"#
        )
        .fetch_optional(pool)
        .await
    }

    /// Find the singleton recurrent-routine workspace for a given routine id
    /// (non-archived), if any. Mirrors `find_orchestrator`, scoped by `name`
    /// since there is one persistent workspace per routine. Newest first as a
    /// tie-break, though at most one should ever be active per routine.
    pub async fn find_recurrent_by_name(
        pool: &SqlitePool,
        name: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Workspace,
            r#"SELECT  id                AS "id!: Uuid",
                       task_id           AS "task_id: Uuid",
                       container_ref,
                       branch,
                       setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                       created_at        AS "created_at!: DateTime<Utc>",
                       updated_at        AS "updated_at!: DateTime<Utc>",
                       archived          AS "archived!: bool",
                       pinned            AS "pinned!: bool",
                       name,
                       worktree_deleted  AS "worktree_deleted!: bool",
                       ephemeral         AS "ephemeral!: bool",
                       kind              AS "kind: WorkspaceKind",
                       current_pipeline_stage
               FROM    workspaces
               WHERE   kind = 'recurrent' AND name = $1 AND archived = FALSE
               ORDER BY created_at DESC
               LIMIT 1"#,
            name
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn update_branch_name(
        pool: &SqlitePool,
        workspace_id: Uuid,
        new_branch_name: &str,
    ) -> Result<(), WorkspaceError> {
        sqlx::query!(
            "UPDATE workspaces SET branch = $1, updated_at = datetime('now') WHERE id = $2",
            new_branch_name,
            workspace_id,
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// Find workspace by path using container-ref path containment.
    /// Used by clients that may open a repo subfolder rather than the workspace root.
    pub async fn resolve_container_ref_by_prefix(
        pool: &SqlitePool,
        path: &str,
    ) -> Result<ContainerInfo, sqlx::Error> {
        let workspaces = sqlx::query_as!(
            WorkspaceContainerRefRow,
            r#"SELECT id as "id!: Uuid",
                      container_ref as "container_ref!"
               FROM workspaces
               WHERE container_ref IS NOT NULL"#,
        )
        .fetch_all(pool)
        .await?;

        Self::best_matching_container_ref(
            path,
            workspaces
                .iter()
                .map(|ws| (ws.id, ws.container_ref.as_str())),
        )
        .map(|workspace_id| ContainerInfo { workspace_id })
        .ok_or(sqlx::Error::RowNotFound)
    }

    fn best_matching_container_ref<'a>(
        path: &str,
        candidates: impl Iterator<Item = (Uuid, &'a str)>,
    ) -> Option<Uuid> {
        let path = std::path::Path::new(path);

        candidates
            .filter(|(_, container_ref)| {
                let container_ref = std::path::Path::new(container_ref);
                path.starts_with(container_ref) || container_ref.starts_with(path)
            })
            .max_by_key(|(_, container_ref)| {
                std::path::Path::new(container_ref).components().count()
            })
            .map(|(workspace_id, _)| workspace_id)
    }

    pub async fn set_archived(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: bool,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET archived = $1, updated_at = datetime('now', 'subsec') WHERE id = $2",
            archived,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Update workspace fields. Only non-None values will be updated.
    /// For `name`, pass `Some("")` to clear the name, `Some("foo")` to set it, or `None` to leave unchanged.
    pub async fn update(
        pool: &SqlitePool,
        workspace_id: Uuid,
        archived: Option<bool>,
        pinned: Option<bool>,
        name: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        // Convert empty string to None for name field (to store as NULL)
        let name_value = name.filter(|s| !s.is_empty());
        let name_provided = name.is_some();

        sqlx::query!(
            r#"UPDATE workspaces SET
                archived = COALESCE($1, archived),
                pinned = COALESCE($2, pinned),
                name = CASE WHEN $3 THEN $4 ELSE name END,
                updated_at = datetime('now', 'subsec')
            WHERE id = $5"#,
            archived,
            pinned,
            name_provided,
            name_value,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Persist the workspace's currently-reported pipeline stage (1-based,
    /// `None` = not yet reported / reset for a new coding-agent run).
    /// Single source of truth for `VK-PIPELINE-STAGE` marker detection.
    pub async fn set_current_pipeline_stage(
        pool: &SqlitePool,
        workspace_id: Uuid,
        stage: Option<i64>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            "UPDATE workspaces SET current_pipeline_stage = $1, updated_at = datetime('now', 'subsec') WHERE id = $2",
            stage,
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn get_first_user_message(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<String>, sqlx::Error> {
        let actions = sqlx::query_scalar!(
            r#"SELECT ep.executor_action as "executor_action!: sqlx::types::Json<ExecutorActionField>"
               FROM sessions s
               JOIN execution_processes ep ON ep.session_id = s.id
               WHERE s.workspace_id = $1
               ORDER BY s.created_at ASC, ep.created_at ASC"#,
            workspace_id
        )
        .fetch_all(pool)
        .await?;

        for action in actions {
            if let ExecutorActionField::ExecutorAction(action) = action.0
                && let Some(prompt) = Self::extract_first_prompt_from_executor_action(&action)
            {
                return Ok(Some(prompt));
            }
        }

        Ok(None)
    }

    fn extract_first_prompt_from_executor_action(action: &ExecutorAction) -> Option<String> {
        let mut current = Some(action);
        while let Some(action) = current {
            match action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::CodingAgentFollowUpRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ReviewRequest(request) => {
                    return Some(request.prompt.clone());
                }
                ExecutorActionType::ScriptRequest(_) => {
                    current = action.next_action();
                }
            }
        }
        None
    }

    pub fn truncate_to_name(prompt: &str, max_len: usize) -> String {
        let trimmed = prompt.trim();
        if trimmed.chars().count() <= max_len {
            trimmed.to_string()
        } else {
            let truncated: String = trimmed.chars().take(max_len).collect();
            if let Some(last_space) = truncated.rfind(' ') {
                format!("{}...", &truncated[..last_space])
            } else {
                format!("{}...", truncated)
            }
        }
    }

    pub async fn find_all_with_status(
        pool: &SqlitePool,
        archived: Option<bool>,
        limit: Option<i64>,
    ) -> Result<Vec<WorkspaceWithStatus>, sqlx::Error> {
        // Fetch all workspaces with status (uses cached SQLx query)
        let records = sqlx::query!(
            r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",
                w.ephemeral AS "ephemeral!: bool",
                w.kind AS "kind: WorkspaceKind",
                w.current_pipeline_stage,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.ephemeral = FALSE
            ORDER BY w.updated_at DESC"#
        )
        .fetch_all(pool)
        .await?;

        let mut workspaces: Vec<WorkspaceWithStatus> = records
            .into_iter()
            .map(|rec| WorkspaceWithStatus {
                workspace: Workspace {
                    id: rec.id,
                    task_id: rec.task_id,
                    container_ref: rec.container_ref,
                    branch: rec.branch,
                    setup_completed_at: rec.setup_completed_at,
                    created_at: rec.created_at,
                    updated_at: rec.updated_at,
                    archived: rec.archived,
                    pinned: rec.pinned,
                    name: rec.name,
                    worktree_deleted: rec.worktree_deleted,
                    ephemeral: rec.ephemeral,
                    kind: rec.kind,
                    current_pipeline_stage: rec.current_pipeline_stage,
                },
                is_running: rec.is_running != 0,
                is_errored: rec.is_errored != 0,
            })
            // Apply archived filter if provided
            .filter(|ws| archived.is_none_or(|a| ws.workspace.archived == a))
            .collect();

        // Apply limit if provided (already sorted by updated_at DESC from query)
        if let Some(lim) = limit {
            workspaces.truncate(lim as usize);
        }

        for ws in &mut workspaces {
            if ws.workspace.name.is_none()
                && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
            {
                let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
                Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
                ws.workspace.name = Some(name);
            }
        }

        Ok(workspaces)
    }

    /// Delete a workspace by ID
    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM workspaces WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Count total workspaces across all projects
    pub async fn find_by_id_with_status(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Option<WorkspaceWithStatus>, sqlx::Error> {
        let rec = sqlx::query!(
            r#"SELECT
                w.id AS "id!: Uuid",
                w.task_id AS "task_id: Uuid",
                w.container_ref,
                w.branch,
                w.setup_completed_at AS "setup_completed_at: DateTime<Utc>",
                w.created_at AS "created_at!: DateTime<Utc>",
                w.updated_at AS "updated_at!: DateTime<Utc>",
                w.archived AS "archived!: bool",
                w.pinned AS "pinned!: bool",
                w.name,
                w.worktree_deleted AS "worktree_deleted!: bool",
                w.ephemeral AS "ephemeral!: bool",
                w.kind AS "kind: WorkspaceKind",
                w.current_pipeline_stage,

                CASE WHEN EXISTS (
                    SELECT 1
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.status = 'running'
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    LIMIT 1
                ) THEN 1 ELSE 0 END AS "is_running!: i64",

                CASE WHEN (
                    SELECT ep.status
                    FROM sessions s
                    JOIN execution_processes ep ON ep.session_id = s.id
                    WHERE s.workspace_id = w.id
                      AND ep.run_reason IN ('setupscript','cleanupscript','codingagent')
                    ORDER BY ep.created_at DESC
                    LIMIT 1
                ) IN ('failed','killed') THEN 1 ELSE 0 END AS "is_errored!: i64"

            FROM workspaces w
            WHERE w.id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await?;

        let Some(rec) = rec else {
            return Ok(None);
        };

        let mut ws = WorkspaceWithStatus {
            workspace: Workspace {
                id: rec.id,
                task_id: rec.task_id,
                container_ref: rec.container_ref,
                branch: rec.branch,
                setup_completed_at: rec.setup_completed_at,
                created_at: rec.created_at,
                updated_at: rec.updated_at,
                archived: rec.archived,
                pinned: rec.pinned,
                name: rec.name,
                worktree_deleted: rec.worktree_deleted,
                ephemeral: rec.ephemeral,
                kind: rec.kind,
                current_pipeline_stage: rec.current_pipeline_stage,
            },
            is_running: rec.is_running != 0,
            is_errored: rec.is_errored != 0,
        };

        if ws.workspace.name.is_none()
            && let Some(prompt) = Self::get_first_user_message(pool, ws.workspace.id).await?
        {
            let name = Self::truncate_to_name(&prompt, WORKSPACE_NAME_MAX_LEN);
            Self::update(pool, ws.workspace.id, None, None, Some(&name)).await?;
            ws.workspace.name = Some(name);
        }

        Ok(Some(ws))
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::{CreateWorkspace, SqlitePool, Workspace, WorkspaceKind};

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn create_marks_normal_workspace_non_ephemeral() {
        let pool = pool().await;
        let ws = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/normal".to_string(),
                name: Some("normal".to_string()),
                kind: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert!(!ws.ephemeral);
        assert!(ws.kind.is_none());
    }

    #[tokio::test]
    async fn ephemeral_workspaces_are_flagged_findable_and_excluded_from_list() {
        let pool = pool().await;

        let normal = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/normal".to_string(),
                name: Some("normal".to_string()),
                kind: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        let ephemeral = Workspace::create_ephemeral(
            &pool,
            &CreateWorkspace {
                branch: "vk/spec-intake".to_string(),
                name: Some("spec-intake".to_string()),
                kind: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert!(ephemeral.ephemeral);

        // find_ephemeral returns only the ephemeral workspace.
        let found = Workspace::find_ephemeral(&pool).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, ephemeral.id);

        // The kanban/UI list excludes ephemeral workspaces.
        let listed = Workspace::find_all_with_status(&pool, None, None)
            .await
            .unwrap();
        let listed_ids: Vec<Uuid> = listed.iter().map(|w| w.workspace.id).collect();
        assert!(listed_ids.contains(&normal.id));
        assert!(!listed_ids.contains(&ephemeral.id));
    }

    #[tokio::test]
    async fn workspace_kind_round_trips_through_create_and_queries() {
        let pool = pool().await;

        let created = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/orchestrator".to_string(),
                name: Some("Orchestrator".to_string()),
                kind: Some(WorkspaceKind::Orchestrator),
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(created.kind, Some(WorkspaceKind::Orchestrator));

        // find_by_id preserves the discriminator.
        let fetched = Workspace::find_by_id(&pool, created.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.kind, Some(WorkspaceKind::Orchestrator));

        // The list query (WorkspaceWithStatus) carries the discriminator too.
        let listed = Workspace::find_all_with_status(&pool, None, None)
            .await
            .unwrap();
        let row = listed
            .iter()
            .find(|w| w.workspace.id == created.id)
            .expect("orchestrator workspace listed");
        assert_eq!(row.workspace.kind, Some(WorkspaceKind::Orchestrator));

        // A normal workspace has no kind.
        let normal = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/plain".to_string(),
                name: Some("plain".to_string()),
                kind: None,
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(normal.kind, None);
    }

    #[tokio::test]
    async fn recurrent_workspace_excluded_from_reaper_and_is_no_worktree() {
        use chrono::{Duration, Utc};

        let pool = pool().await;

        let created = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "vk/recurrent".to_string(),
                name: Some("nightly-cleanup".to_string()),
                kind: Some(WorkspaceKind::Recurrent),
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();
        assert_eq!(created.kind, Some(WorkspaceKind::Recurrent));
        assert!(created.kind.unwrap().is_no_worktree());

        // find_by_id preserves the discriminator.
        let fetched = Workspace::find_by_id(&pool, created.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched.kind, Some(WorkspaceKind::Recurrent));

        // Recurrent workspaces still surface as ordinary sessions in the list
        // query (they are not hidden like ephemeral workspaces).
        let listed = Workspace::find_all_with_status(&pool, None, None)
            .await
            .unwrap();
        let listed_ids: Vec<Uuid> = listed.iter().map(|w| w.workspace.id).collect();
        assert!(listed_ids.contains(&created.id));

        // Set a container_ref and backdate updated_at so this workspace WOULD
        // be reaped (standard cleanup threshold is 72 hours) if the reaper
        // filter did not exclude non-card kinds.
        let old_updated_at = Utc::now() - Duration::hours(100);
        let container_ref = "/tmp/does-not-matter".to_string();
        sqlx::query("UPDATE workspaces SET container_ref = ?, updated_at = ? WHERE id = ?")
            .bind(container_ref)
            .bind(old_updated_at)
            .bind(created.id)
            .execute(&pool)
            .await
            .unwrap();

        let expired = Workspace::find_expired_for_cleanup(&pool).await.unwrap();
        let expired_ids: Vec<Uuid> = expired.iter().map(|w| w.id).collect();
        assert!(!expired_ids.contains(&created.id));

        // No cross-talk: find_orchestrator returns None when only a
        // recurrent workspace exists.
        assert!(Workspace::find_orchestrator(&pool).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn find_recurrent_by_name_scopes_by_name_and_archived() {
        let pool = pool().await;

        let routine_a = Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "nightly-cleanup".to_string(),
                name: Some("nightly-cleanup".to_string()),
                kind: Some(WorkspaceKind::Recurrent),
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        Workspace::create(
            &pool,
            &CreateWorkspace {
                branch: "inbox-triage".to_string(),
                name: Some("inbox-triage".to_string()),
                kind: Some(WorkspaceKind::Recurrent),
            },
            Uuid::new_v4(),
        )
        .await
        .unwrap();

        // Finds the exact routine by name, not the other one.
        let found = Workspace::find_recurrent_by_name(&pool, "nightly-cleanup")
            .await
            .unwrap();
        assert_eq!(found.map(|w| w.id), Some(routine_a.id));

        // No routine with this name.
        assert!(
            Workspace::find_recurrent_by_name(&pool, "does-not-exist")
                .await
                .unwrap()
                .is_none()
        );

        // Archiving hides it (a fresh singleton would be created next spawn).
        Workspace::set_archived(&pool, routine_a.id, true)
            .await
            .unwrap();
        assert!(
            Workspace::find_recurrent_by_name(&pool, "nightly-cleanup")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn non_card_kinds_serialize_to_expected_sql_literals() {
        // Drift guard: keeps WorkspaceKind::NON_CARD, WorkspaceKind::as_sql_str,
        // and the hardcoded SQL literal list in find_expired_for_cleanup's
        // reaper filter in sync with each other.
        let expected_sql_literals = ["orchestrator", "recurrent"];

        for kind in WorkspaceKind::NON_CARD {
            let serialized = serde_json::to_string(kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_sql_str()));
            assert!(
                expected_sql_literals.contains(&kind.as_sql_str()),
                "as_sql_str() for {kind:?} ({}) is missing from the reaper filter's \
                 hardcoded literal list — update both together",
                kind.as_sql_str()
            );
        }
    }

    #[test]
    fn best_matching_container_ref_prefers_deepest_match() {
        let broad_id = Uuid::new_v4();
        let exact_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo/packages/app",
            [(broad_id, "/tmp"), (exact_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, Some(exact_id));
    }

    #[test]
    fn best_matching_container_ref_supports_parent_request_path() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/ws/repo",
            [(workspace_id, "/tmp/ws/repo/packages/app")].into_iter(),
        );

        assert_eq!(selected, Some(workspace_id));
    }

    #[test]
    fn best_matching_container_ref_ignores_unrelated_paths() {
        let workspace_id = Uuid::new_v4();
        let selected = Workspace::best_matching_container_ref(
            "/tmp/other/path",
            [(workspace_id, "/tmp/ws")].into_iter(),
        );

        assert_eq!(selected, None);
    }
}
