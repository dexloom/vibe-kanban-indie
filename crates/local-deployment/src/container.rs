use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::anyhow;
use async_trait::async_trait;
use command_group::AsyncGroupChild;
use db::{
    DBService,
    models::{
        coding_agent_turn::CodingAgentTurn,
        execution_process::{
            ExecutionContext, ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus,
        },
        execution_process_repo_state::ExecutionProcessRepoState,
        repo::Repo,
        scratch::{DraftFollowUpData, Scratch, ScratchType},
        session::{Session, SessionError},
        workspace::Workspace,
        workspace_repo::WorkspaceRepo,
    },
};
use deployment::DeploymentError;
use executors::{
    actions::{
        Executable, ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
    },
    approvals::{ExecutorApprovalService, NoopExecutorApprovalService},
    env::{ExecutionEnv, RepoContext},
    executors::{
        BaseCodingAgent, CancellationToken, ExecutorExitResult, ExecutorExitSignal,
        StandardCodingAgentExecutor,
    },
    interactive::{self, InteractiveTmuxConfig},
    logs::{NormalizedEntryType, utils::patch::extract_normalized_entry_from_patch},
};
use futures::{FutureExt, TryStreamExt, stream::select};
use git::GitService;
use serde_json::json;
use services::services::{
    analytics::AnalyticsContext,
    approvals::{Approvals, executor_approvals::ExecutorApprovalBridge},
    config::{Config, DEFAULT_COMMIT_REMINDER_PROMPT},
    container::{ContainerError, ContainerRef, ContainerService},
    diff_stream::{self, DiffStreamHandle},
    execution_process,
    file::FileService,
    notification::NotificationService,
    queued_message::QueuedMessageService,
    remote_client::RemoteClient,
    remote_sync,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncSeekExt, BufReader},
    sync::RwLock,
    task::JoinHandle,
};
use tokio_util::io::ReaderStream;
use utils::{
    log_msg::LogMsg,
    msg_store::MsgStore,
    text::{git_branch_id, short_uuid, truncate_to_char_boundary},
};
use uuid::Uuid;
use workspace_manager::{RepoWorkspaceInput, WorkspaceError, WorkspaceManager};

use crate::{command, copy, terminal};

const WORKSPACE_TOUCH_DEBOUNCE: Duration = Duration::from_mins(2);

/// How often the detached liveness poller checks whether the tmux session is
/// still alive.
const DETACHED_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Runtime tracking for an interactive (detached tmux) execution. Unlike owned
/// child processes (`child_store`), a detached tmux session is not an
/// `AsyncGroupChild`; it is tracked by name with a transcript tail + liveness
/// poller that mirror its output and detect completion.
struct DetachedHandle {
    /// tmux session name = `interactive::tmux_session_name(exec_id)`.
    tmux_session: String,
    /// Cancels both the transcript tail and the liveness poller.
    cancel: CancellationToken,
    tail_handle: JoinHandle<()>,
    poll_handle: JoinHandle<()>,
}

#[derive(Clone)]
pub struct LocalContainerService {
    db: DBService,
    workspace_manager: WorkspaceManager,
    child_store: Arc<RwLock<HashMap<Uuid, Arc<RwLock<AsyncGroupChild>>>>>,
    /// Interactive (detached tmux) executions, keyed by execution id.
    detached_store: Arc<RwLock<HashMap<Uuid, DetachedHandle>>>,
    cancellation_tokens: Arc<RwLock<HashMap<Uuid, CancellationToken>>>,
    msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
    /// Tracks background tasks that stream logs to the database.
    /// When stopping execution, we await these to ensure logs are fully persisted.
    db_stream_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    exit_monitor_handles: Arc<RwLock<HashMap<Uuid, JoinHandle<()>>>>,
    workspace_touch_times: Arc<RwLock<HashMap<Uuid, Instant>>>,
    config: Arc<RwLock<Config>>,
    git: GitService,
    file_service: FileService,
    analytics: Option<AnalyticsContext>,
    approvals: Approvals,
    queued_message_service: QueuedMessageService,
    notification_service: NotificationService,
    remote_client: Option<RemoteClient>,
}

impl LocalContainerService {
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        db: DBService,
        workspace_manager: WorkspaceManager,
        msg_stores: Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>>,
        config: Arc<RwLock<Config>>,
        git: GitService,
        file_service: FileService,
        analytics: Option<AnalyticsContext>,
        approvals: Approvals,
        queued_message_service: QueuedMessageService,
        remote_client: Option<RemoteClient>,
    ) -> Self {
        let child_store = Arc::new(RwLock::new(HashMap::new()));
        let detached_store = Arc::new(RwLock::new(HashMap::new()));
        let cancellation_tokens = Arc::new(RwLock::new(HashMap::new()));
        let db_stream_handles = Arc::new(RwLock::new(HashMap::new()));
        let exit_monitor_handles = Arc::new(RwLock::new(HashMap::new()));
        let workspace_touch_times = Arc::new(RwLock::new(HashMap::new()));
        let notification_service = NotificationService::new(config.clone());

        let container = LocalContainerService {
            db,
            workspace_manager,
            child_store,
            detached_store,
            cancellation_tokens,
            msg_stores,
            db_stream_handles,
            exit_monitor_handles,
            workspace_touch_times,
            config,
            git,
            file_service,
            analytics,
            approvals,
            queued_message_service,
            notification_service,
            remote_client,
        };

        container.spawn_workspace_cleanup();

        container
    }

    fn map_workspace_manager_error(err: WorkspaceError) -> ContainerError {
        match err {
            WorkspaceError::Database(err) => ContainerError::Sqlx(err),
            WorkspaceError::Worktree(err) => ContainerError::Worktree(err),
            WorkspaceError::GitService(err) => ContainerError::GitServiceError(err),
            WorkspaceError::Io(err) => ContainerError::Io(err),
            WorkspaceError::NoRepositories => {
                ContainerError::Other(anyhow!("No repositories provided"))
            }
            WorkspaceError::Repo(err) => ContainerError::Other(anyhow!(err)),
            WorkspaceError::WorkspaceNotFound => {
                ContainerError::Other(anyhow!("Workspace not found"))
            }
            WorkspaceError::RepoAlreadyAttached => {
                ContainerError::Other(anyhow!("Repository already attached to workspace"))
            }
            WorkspaceError::BranchNotFound { repo_name, branch } => ContainerError::Other(anyhow!(
                "Branch '{}' does not exist in repository '{}'",
                branch,
                repo_name
            )),
            WorkspaceError::PartialCreation(msg) => ContainerError::Other(anyhow!(msg)),
        }
    }

    async fn workspace_repo_inputs(
        &self,
        workspace_id: Uuid,
    ) -> Result<(Vec<Repo>, Vec<RepoWorkspaceInput>), ContainerError> {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace_id).await?;
        if workspace_repos.is_empty() {
            return Err(ContainerError::Other(anyhow!(
                "Workspace has no repositories configured"
            )));
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace_id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let workspace_inputs: Vec<RepoWorkspaceInput> = repositories
            .iter()
            .map(|repo| {
                let target_branch = target_branches.get(&repo.id).cloned().ok_or_else(|| {
                    ContainerError::Other(anyhow!(
                        "Missing target branch mapping for repo {} in workspace {}",
                        repo.id,
                        workspace_id
                    ))
                })?;
                Ok(RepoWorkspaceInput::new(repo.clone(), target_branch))
            })
            .collect::<Result<_, ContainerError>>()?;

        Ok((repositories, workspace_inputs))
    }

    async fn get_child_from_store(&self, id: &Uuid) -> Option<Arc<RwLock<AsyncGroupChild>>> {
        let map = self.child_store.read().await;
        map.get(id).cloned()
    }

    async fn add_child_to_store(&self, id: Uuid, exec: AsyncGroupChild) {
        let mut map = self.child_store.write().await;
        map.insert(id, Arc::new(RwLock::new(exec)));
    }

    async fn remove_child_from_store(&self, id: &Uuid) {
        let mut map = self.child_store.write().await;
        map.remove(id);
    }

    async fn add_cancellation_token(&self, id: Uuid, token: CancellationToken) {
        let mut map = self.cancellation_tokens.write().await;
        map.insert(id, token);
    }

    async fn take_cancellation_token(&self, id: &Uuid) -> Option<CancellationToken> {
        let mut map = self.cancellation_tokens.write().await;
        map.remove(id)
    }

    async fn add_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.db_stream_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.db_stream_handles.write().await;
        map.remove(id)
    }

    async fn add_exit_monitor_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        let mut map = self.exit_monitor_handles.write().await;
        map.insert(id, handle);
    }

    async fn take_exit_monitor_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        let mut map = self.exit_monitor_handles.write().await;
        map.remove(id)
    }

    async fn cleanup_workspace(&self, workspace: &Workspace) {
        let Some(container_ref) = &workspace.container_ref else {
            return;
        };
        let workspace_dir = PathBuf::from(container_ref);

        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id)
            .await
            .unwrap_or_default();

        if repositories.is_empty() {
            tracing::warn!(
                "No repositories found for workspace {}, cleaning up workspace directory only",
                workspace.id
            );
            if workspace_dir.exists()
                && let Err(e) = tokio::fs::remove_dir_all(&workspace_dir).await
            {
                tracing::warn!("Failed to remove workspace directory: {}", e);
            }
        } else {
            WorkspaceManager::cleanup_workspace(&workspace_dir, &repositories)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(
                        "Failed to clean up workspace for workspace {}: {}",
                        workspace.id,
                        e
                    );
                });
        }

        let _ = Workspace::mark_worktree_deleted(&self.db.pool, workspace.id).await;
    }

    async fn cleanup_expired_workspaces(&self) -> Result<(), DeploymentError> {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            tracing::info!(
                "Expired workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return Ok(());
        }

        let expired_workspaces = Workspace::find_expired_for_cleanup(&self.db.pool).await?;
        if expired_workspaces.is_empty() {
            tracing::debug!("No expired workspaces found");
            return Ok(());
        }
        tracing::info!(
            "Found {} expired workspaces to clean up",
            expired_workspaces.len()
        );
        for workspace in &expired_workspaces {
            self.cleanup_workspace(workspace).await;
        }
        Ok(())
    }

    /// Delete any leftover ephemeral (spec-intake) workspaces from a prior run
    /// that crashed mid-generation. Keyed on the durable `ephemeral` flag, not a
    /// name, so it can never touch a real user workspace.
    async fn reap_ephemeral_workspaces(&self) {
        let ephemeral = match Workspace::find_ephemeral(&self.db.pool).await {
            Ok(ws) => ws,
            Err(e) => {
                tracing::warn!("Failed to query ephemeral workspaces for reaping: {}", e);
                return;
            }
        };
        for workspace in ephemeral {
            let workspace_id = workspace.id;
            match self
                .workspace_manager
                .load_managed_workspace(workspace)
                .await
            {
                Ok(managed) => match managed.prepare_deletion_context().await {
                    Ok(ctx) => {
                        if let Err(e) = managed.delete_record().await {
                            tracing::warn!(
                                "Failed to delete leftover ephemeral workspace {}: {}",
                                workspace_id,
                                e
                            );
                        }
                        WorkspaceManager::spawn_workspace_deletion_cleanup(ctx, true);
                        tracing::info!("Reaped leftover ephemeral workspace {}", workspace_id);
                    }
                    Err(e) => tracing::warn!(
                        "Failed to prepare deletion for ephemeral workspace {}: {}",
                        workspace_id,
                        e
                    ),
                },
                Err(e) => tracing::warn!(
                    "Failed to load ephemeral workspace {} for reaping: {}",
                    workspace_id,
                    e
                ),
            }
        }
    }

    fn spawn_workspace_cleanup(&self) {
        let container = self.clone();
        tokio::spawn(async move {
            // Reap leftover ephemeral workspaces first (after the orphan-execution
            // reconciliation that runs during server startup).
            container.reap_ephemeral_workspaces().await;

            container
                .workspace_manager
                .cleanup_orphan_workspaces()
                .await;

            let mut cleanup_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(1800)); // 30 minutes
            loop {
                cleanup_interval.tick().await;
                tracing::info!("Starting periodic workspace cleanup...");
                container
                    .cleanup_expired_workspaces()
                    .await
                    .unwrap_or_else(|e| {
                        tracing::error!("Failed to clean up expired workspaces: {}", e)
                    });
            }
        });
    }

    /// Record the current HEAD commit for each repository as the "after" state.
    /// Errors are silently ignored since this runs after the main execution completes
    /// and failure should not block process finalization.
    async fn update_after_head_commits(&self, exec_id: Uuid) {
        if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, exec_id).await {
            let workspace_root = self.workspace_to_current_dir(&ctx.workspace);
            for repo in &ctx.repos {
                let repo_path = workspace_root.join(&repo.name);
                if let Ok(head) = self.git().get_head_info(&repo_path) {
                    let _ = ExecutionProcessRepoState::update_after_head_commit(
                        &self.db.pool,
                        exec_id,
                        repo.id,
                        &head.oid,
                    )
                    .await;
                }
            }
        }
    }

    /// Get the commit message based on the execution run reason.
    async fn get_commit_message(&self, ctx: &ExecutionContext) -> String {
        match ctx.execution_process.run_reason {
            ExecutionProcessRunReason::CodingAgent => {
                // Try to retrieve the task summary from the coding agent turn
                // otherwise fallback to default message
                match CodingAgentTurn::find_by_execution_process_id(
                    &self.db().pool,
                    ctx.execution_process.id,
                )
                .await
                {
                    Ok(Some(turn)) if turn.summary.is_some() => turn.summary.unwrap(),
                    Ok(_) => {
                        tracing::debug!(
                            "No summary found for execution process {}, using default message",
                            ctx.execution_process.id
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                    Err(e) => {
                        tracing::debug!(
                            "Failed to retrieve summary for execution process {}: {}",
                            ctx.execution_process.id,
                            e
                        );
                        format!(
                            "Commit changes from coding agent for workspace {}",
                            ctx.workspace.id
                        )
                    }
                }
            }
            ExecutionProcessRunReason::CleanupScript => {
                format!("Cleanup script changes for workspace {}", ctx.workspace.id)
            }
            _ => format!(
                "Changes from execution process {}",
                ctx.execution_process.id
            ),
        }
    }

    /// Check which repos have uncommitted changes. Fails if any repo is inaccessible.
    fn check_repos_for_changes(
        &self,
        workspace_root: &Path,
        repos: &[Repo],
    ) -> Result<Vec<(Repo, PathBuf)>, ContainerError> {
        let git = GitService::new();
        let mut repos_with_changes = Vec::new();

        for repo in repos {
            let worktree_path = workspace_root.join(&repo.name);

            match git.get_worktree_status(&worktree_path) {
                Ok(ws) if !ws.entries.is_empty() => {
                    repos_with_changes.push((repo.clone(), worktree_path));
                }
                Ok(_) => {
                    tracing::debug!("No changes in repo '{}'", repo.name);
                }
                Err(e) => {
                    return Err(ContainerError::Other(anyhow!(
                        "Pre-flight check failed for repo '{}': {}",
                        repo.name,
                        e
                    )));
                }
            }
        }

        Ok(repos_with_changes)
    }

    async fn has_commits_from_execution(
        &self,
        ctx: &ExecutionContext,
    ) -> Result<bool, ContainerError> {
        let workspace_root = self.workspace_to_current_dir(&ctx.workspace);

        let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(
            &self.db.pool,
            ctx.execution_process.id,
        )
        .await?;

        for repo in &ctx.repos {
            let repo_path = workspace_root.join(&repo.name);
            let current_head = self.git().get_head_info(&repo_path).ok().map(|h| h.oid);

            let before_head = repo_states
                .iter()
                .find(|s| s.repo_id == repo.id)
                .and_then(|s| s.before_head_commit.clone());

            if current_head != before_head {
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Commit changes to each repo. Logs failures but continues with other repos.
    fn commit_repos(&self, repos_with_changes: Vec<(Repo, PathBuf)>, message: &str) -> bool {
        let mut any_committed = false;

        for (repo, worktree_path) in repos_with_changes {
            tracing::debug!(
                "Committing changes for repo '{}' at {:?}",
                repo.name,
                &worktree_path
            );

            match self.git().commit(&worktree_path, message) {
                Ok(true) => {
                    any_committed = true;
                    tracing::info!("Committed changes in repo '{}'", repo.name);
                }
                Ok(false) => {
                    tracing::warn!("No changes committed in repo '{}' (unexpected)", repo.name);
                }
                Err(e) => {
                    tracing::warn!("Failed to commit in repo '{}': {}", repo.name, e);
                }
            }
        }

        any_committed
    }

    /// Finalize an execution that has completed (process exited, or — for a
    /// detached tmux session — the session ended). Marks completion, commits
    /// changes, chains the next action / queued follow-up, finalizes the task,
    /// fires analytics + remote sync, and tears down the MsgStore / db stream /
    /// child handle.
    ///
    /// Shared by [`Self::spawn_exit_monitor`] (owned child processes) and the
    /// detached tmux liveness poller, so both modes reach the same end state.
    async fn finalize_completed_execution(
        &self,
        exec_id: Uuid,
        exit_code: Option<i64>,
        status: ExecutionProcessStatus,
    ) {
        let db = &self.db;
        let config = &self.config;
        let analytics = &self.analytics;
        let container = self;

        // Resolve any approvals still parked on this execution (e.g. a headed
        // session that exited while a tool approval was pending) so the headed
        // bridge's blocked HTTP request returns promptly rather than timing out.
        self.approvals.cancel_for_execution_process(exec_id);

        if !ExecutionProcess::was_stopped(&db.pool, exec_id).await
            && let Err(e) =
                ExecutionProcess::update_completion(&db.pool, exec_id, status, exit_code).await
        {
            tracing::error!("Failed to update execution process completion: {}", e);
        }

        if let Ok(ctx) = ExecutionProcess::load_context(&db.pool, exec_id).await {
            // Ephemeral workspaces (spec-intake) are throwaway: skip ALL normal
            // finalize side effects — commit, next-action, queued follow-ups,
            // task finalize, unseen marking, analytics, and remote sync.
            // Completion status was already persisted above, and MsgStore/stream
            // teardown still happens below regardless.
            if !ctx.workspace.ephemeral {
                // Update executor session summary if available
                if let Err(e) = container.update_executor_session_summary(&exec_id).await {
                    tracing::warn!("Failed to update executor session summary: {}", e);
                }

                let success = matches!(
                    ctx.execution_process.status,
                    ExecutionProcessStatus::Completed
                ) && exit_code == Some(0);

                let cleanup_done = matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CleanupScript
                ) && !matches!(
                    ctx.execution_process.status,
                    ExecutionProcessStatus::Running
                );

                let mut already_finalized = false;

                if success || cleanup_done {
                    // Commit changes (if any) and get feedback about whether changes were made
                    let changes_committed = match container.try_commit_changes(&ctx).await {
                        Ok(committed) => committed,
                        Err(e) => {
                            tracing::error!("Failed to commit changes after execution: {}", e);
                            // Treat commit failures as if changes were made to be safe
                            true
                        }
                    };

                    let should_start_next = if matches!(
                        ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    ) {
                        // Check if agent made commits OR if we just committed uncommitted changes
                        changes_committed
                            || container
                                .has_commits_from_execution(&ctx)
                                .await
                                .unwrap_or(false)
                    } else {
                        true
                    };

                    if should_start_next {
                        // If the process exited successfully, start the next action
                        if let Err(e) = container.try_start_next_action(&ctx).await {
                            tracing::error!("Failed to start next action after completion: {}", e);
                        }
                    } else {
                        tracing::info!(
                            "Skipping cleanup script for workspace {} - no changes made by coding agent",
                            ctx.workspace.id
                        );

                        // Manually finalize task since we're bypassing normal execution flow
                        container.finalize_task(&ctx).await;
                        already_finalized = true;
                    }
                }

                if !already_finalized && container.should_finalize(&ctx) {
                    let has_chained_follow_up = ctx
                        .execution_process
                        .executor_action()
                        .ok()
                        .and_then(|action| action.next_action())
                        .is_some();
                    let mut started_queued_follow_up = false;

                    // Only execute queued messages if the execution succeeded
                    // If it failed or was killed, just clear the queue and finalize
                    let should_execute_queued = !matches!(
                        ctx.execution_process.status,
                        ExecutionProcessStatus::Failed | ExecutionProcessStatus::Killed
                    );

                    if let Some(queued_msg) =
                        container.queued_message_service.take_queued(ctx.session.id)
                    {
                        if should_execute_queued {
                            tracing::info!(
                                "Found queued message for session {}, starting follow-up execution",
                                ctx.session.id
                            );

                            // Delete the scratch since we're consuming the queued message
                            if let Err(e) = Scratch::delete(
                                &db.pool,
                                ctx.session.id,
                                &ScratchType::DraftFollowUp,
                            )
                            .await
                            {
                                tracing::warn!(
                                    "Failed to delete scratch after consuming queued message: {}",
                                    e
                                );
                            }

                            // Execute the queued follow-up
                            if let Err(e) = container
                                .start_queued_follow_up(&ctx, &queued_msg.data)
                                .await
                            {
                                tracing::error!("Failed to start queued follow-up: {}", e);
                                // Fall back to finalization if follow-up fails
                                container.finalize_task(&ctx).await;
                            } else {
                                started_queued_follow_up = true;
                            }
                        } else {
                            // Execution failed or was killed - discard the queued message and finalize
                            tracing::info!(
                                "Discarding queued message for session {} due to execution status {:?}",
                                ctx.session.id,
                                ctx.execution_process.status
                            );
                            container.finalize_task(&ctx).await;
                        }
                    } else {
                        container.finalize_task(&ctx).await;
                    }

                    let should_mark_turn_unseen = matches!(
                        ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    ) && !has_chained_follow_up
                        && !started_queued_follow_up;

                    if should_mark_turn_unseen
                        && let Err(e) = CodingAgentTurn::mark_unseen_by_execution_process_id(
                            &db.pool,
                            ctx.execution_process.id,
                        )
                        .await
                    {
                        tracing::warn!(
                            "Failed to mark coding agent turn unseen for execution {}: {}",
                            ctx.execution_process.id,
                            e
                        );
                    }
                }

                // When a parallel setup script finishes and no coding agent is running,
                // consume any queued message that was stuck waiting
                if matches!(
                    ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::SetupScript
                ) && !container.should_finalize(&ctx)
                {
                    let has_running_agent = ExecutionProcess::has_running_coding_agent_for_session(
                        &db.pool,
                        ctx.session.id,
                    )
                    .await
                    .unwrap_or(true);

                    if !has_running_agent
                        && let Some(queued_msg) =
                            container.queued_message_service.take_queued(ctx.session.id)
                    {
                        tracing::info!(
                            "Parallel setup script finished with queued message for session {}, starting follow-up",
                            ctx.session.id
                        );

                        if let Err(e) =
                            Scratch::delete(&db.pool, ctx.session.id, &ScratchType::DraftFollowUp)
                                .await
                        {
                            tracing::warn!(
                                "Failed to delete scratch after consuming queued message: {}",
                                e
                            );
                        }

                        if let Err(e) = container
                            .start_queued_follow_up(&ctx, &queued_msg.data)
                            .await
                        {
                            tracing::error!(
                                "Failed to start queued follow-up from setup script completion: {}",
                                e
                            );
                        }
                    }
                }

                // Fire analytics event when CodingAgent execution has finished
                if config.read().await.analytics_enabled
                    && matches!(
                        &ctx.execution_process.run_reason,
                        ExecutionProcessRunReason::CodingAgent
                    )
                    && let Some(analytics) = analytics
                {
                    analytics.analytics_service.track_event(&analytics.user_id, "task_attempt_finished", Some(json!({
                    "workspace_id": ctx.workspace.id.to_string(),
                    "session_id": ctx.session.id.to_string(),
                    "execution_success": matches!(ctx.execution_process.status, ExecutionProcessStatus::Completed),
                    "exit_code": ctx.execution_process.exit_code,
                })));
                }

                // Sync workspace to remote after CodingAgent execution
                if matches!(
                    &ctx.execution_process.run_reason,
                    ExecutionProcessRunReason::CodingAgent
                ) && let Some(client) = &container.remote_client
                {
                    let stats = diff_stream::compute_diff_stats(
                        &container.db.pool,
                        &container.git,
                        &ctx.workspace,
                    )
                    .await;
                    let workspace_name =
                        Workspace::find_by_id_with_status(&container.db.pool, ctx.workspace.id)
                            .await
                            .ok()
                            .flatten()
                            .and_then(|ws| ws.workspace.name);
                    let client = client.clone();
                    let workspace_id = ctx.workspace.id;
                    let archived = ctx.workspace.archived;
                    tokio::spawn(async move {
                        remote_sync::sync_workspace_to_remote(
                            &client,
                            workspace_id,
                            workspace_name.map(Some),
                            Some(archived),
                            stats.as_ref(),
                        )
                        .await;
                    });
                }
            } // end: !ctx.workspace.ephemeral
        }

        // Now that commit/next-action/finalization steps for this process are complete,
        // capture the HEAD OID as the definitive "after" state (best-effort).
        container.update_after_head_commits(exec_id).await;

        // Wait for DB persistence to complete before cleaning up MsgStore
        let db_stream_handle = container.take_db_stream_handle(&exec_id).await;
        if let Some(msg_arc) = container.msg_stores.write().await.remove(&exec_id) {
            msg_arc.push_finished();
        }
        if let Some(handle) = db_stream_handle {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }

        // SIGKILL any orphaned children (e.g. MCP servers) still in the
        // process group. The executor itself is already done — either it
        // exited naturally or was killed in the exit-signal branch above.
        if let Some(child_lock) = container.child_store.read().await.get(&exec_id).cloned() {
            let mut child = child_lock.write().await;
            let _ = child.start_kill();
        }
        container.child_store.write().await.remove(&exec_id);
    }

    /// Spawn a background task that polls the child process for completion and
    /// cleans up the execution entry when it exits.
    fn spawn_exit_monitor(
        &self,
        exec_id: &Uuid,
        exit_signal: Option<ExecutorExitSignal>,
    ) -> JoinHandle<()> {
        let exec_id = *exec_id;
        let child_store = self.child_store.clone();
        let container = self.clone();

        let mut process_exit_rx = self.spawn_os_exit_watcher(exec_id);

        tokio::spawn(async move {
            let mut exit_signal_future = exit_signal
                .map(|rx| rx.boxed()) // wait for result
                .unwrap_or_else(|| std::future::pending().boxed()); // no signal, stall forever

            let status_result: std::io::Result<std::process::ExitStatus>;

            // Wait for process to exit, or exit signal from executor
            tokio::select! {
                // Exit signal with result.
                // Some coding agent processes do not automatically exit after processing the user request; instead the executor
                // signals when processing has finished to gracefully kill the process.
                exit_result = &mut exit_signal_future => {
                    // Executor signaled completion: kill group and use the provided result
                    if let Some(child_lock) = child_store.read().await.get(&exec_id).cloned() {
                        let mut child = child_lock.write().await ;
                        if let Err(err) = command::kill_process_group(&mut child).await {
                            tracing::error!("Failed to kill process group after exit signal: {} {}", exec_id, err);
                        }
                    }

                    // Map the exit result to appropriate exit status
                    status_result = match exit_result {
                        Ok(ExecutorExitResult::Success) => Ok(success_exit_status()),
                        Ok(ExecutorExitResult::Failure) => Ok(failure_exit_status()),
                        Err(_) => Ok(success_exit_status()), // Channel closed, assume success
                    };
                }
                // Process exit
                exit_status_result = &mut process_exit_rx => {
                    status_result = exit_status_result.unwrap_or_else(|e| Err(std::io::Error::other(e)));
                }
            }

            let (exit_code, status) = match status_result {
                Ok(exit_status) => {
                    let code = exit_status.code().unwrap_or(-1) as i64;
                    let status = if exit_status.success() {
                        ExecutionProcessStatus::Completed
                    } else {
                        ExecutionProcessStatus::Failed
                    };
                    (Some(code), status)
                }
                Err(_) => (None, ExecutionProcessStatus::Failed),
            };

            container
                .finalize_completed_execution(exec_id, exit_code, status)
                .await;
        })
    }

    fn spawn_os_exit_watcher(
        &self,
        exec_id: Uuid,
    ) -> tokio::sync::oneshot::Receiver<std::io::Result<std::process::ExitStatus>> {
        let (tx, rx) = tokio::sync::oneshot::channel::<std::io::Result<std::process::ExitStatus>>();
        let child_store = self.child_store.clone();
        tokio::spawn(async move {
            loop {
                let child_lock = {
                    let map = child_store.read().await;
                    map.get(&exec_id).cloned()
                };
                if let Some(child_lock) = child_lock {
                    let mut child_handler = child_lock.write().await;
                    match child_handler.try_wait() {
                        Ok(Some(status)) => {
                            let _ = tx.send(Ok(status));
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                } else {
                    let _ = tx.send(Err(io::Error::other(format!(
                        "Child handle missing for {exec_id}"
                    ))));
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        rx
    }

    fn dir_name_from_workspace(workspace_id: &Uuid, task_title: &str) -> String {
        let task_title_id = git_branch_id(task_title);
        format!("{}-{}", short_uuid(workspace_id), task_title_id)
    }

    async fn track_child_msgs_in_store(
        &self,
        id: Uuid,
        child: &mut AsyncGroupChild,
    ) -> Result<(), ContainerError> {
        let store = self
            .get_msg_store_by_id(&id)
            .await
            .ok_or_else(|| ContainerError::Other(anyhow!("MsgStore not found for execution")))?;
        let out = child.inner().stdout.take().expect("no stdout");
        let err = child.inner().stderr.take().expect("no stderr");

        // Map stdout bytes -> LogMsg::Stdout
        let out = ReaderStream::new(out)
            .map_ok(|chunk| LogMsg::Stdout(String::from_utf8_lossy(&chunk).into_owned()));

        // Map stderr bytes -> LogMsg::Stderr
        let err = ReaderStream::new(err)
            .map_ok(|chunk| LogMsg::Stderr(String::from_utf8_lossy(&chunk).into_owned()));

        // If you have a JSON Patch source, map it to LogMsg::JsonPatch too, then select all three.

        // Merge and forward into the store
        let merged = select(out, err); // Stream<Item = Result<LogMsg, io::Error>>
        store.clone().spawn_forwarder(merged);
        Ok(())
    }

    /// Create a live diff log stream for ongoing attempts for WebSocket
    /// Returns a stream that owns the filesystem watcher - when dropped, watcher is cleaned up
    async fn create_live_diff_stream(
        &self,
        args: diff_stream::DiffStreamArgs,
    ) -> Result<DiffStreamHandle, ContainerError> {
        diff_stream::create(args)
            .await
            .map_err(|e| ContainerError::Other(anyhow!("{e}")))
    }

    /// Extract the last assistant message from the MsgStore history
    fn extract_last_assistant_message(&self, exec_id: &Uuid) -> Option<String> {
        // Get the MsgStore for this execution
        let msg_stores = self.msg_stores.try_read().ok()?;
        let msg_store = msg_stores.get(exec_id)?;

        // Get the history and scan in reverse for the last assistant message
        let history = msg_store.get_history();

        for msg in history.iter().rev() {
            if let LogMsg::JsonPatch(patch) = msg {
                // Try to extract a NormalizedEntry from the patch
                if let Some((_, entry)) = extract_normalized_entry_from_patch(patch)
                    && matches!(entry.entry_type, NormalizedEntryType::AssistantMessage)
                {
                    let content = entry.content.trim();
                    if !content.is_empty() {
                        const MAX_SUMMARY_LENGTH: usize = 4096;
                        if content.len() > MAX_SUMMARY_LENGTH {
                            let truncated = truncate_to_char_boundary(content, MAX_SUMMARY_LENGTH);
                            return Some(format!("{truncated}..."));
                        }
                        return Some(content.to_string());
                    }
                }
            }
        }

        None
    }

    /// Update the coding agent turn summary with the final assistant message
    async fn update_executor_session_summary(&self, exec_id: &Uuid) -> Result<(), anyhow::Error> {
        // Check if there's a coding agent turn for this execution process
        let turn = CodingAgentTurn::find_by_execution_process_id(&self.db.pool, *exec_id).await?;

        if let Some(turn) = turn {
            // Only update if summary is not already set
            if turn.summary.is_none() {
                if let Some(summary) = self.extract_last_assistant_message(exec_id) {
                    CodingAgentTurn::update_summary(&self.db.pool, *exec_id, &summary).await?;
                } else {
                    tracing::debug!("No assistant message found for execution {}", exec_id);
                }
            }
        }

        Ok(())
    }

    /// Copy project files and workspace attachments to the workspace.
    /// Skips files that already exist (fast no-op if all exist).
    async fn copy_files_and_images(
        &self,
        workspace_dir: &Path,
        workspace: &Workspace,
    ) -> Result<(), ContainerError> {
        let repos = WorkspaceRepo::find_repos_with_copy_files(&self.db.pool, workspace.id).await?;

        for repo in &repos {
            if let Some(copy_files) = &repo.copy_files
                && !copy_files.trim().is_empty()
            {
                let worktree_path = workspace_dir.join(&repo.name);
                self.copy_project_files(&repo.path, &worktree_path, copy_files)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                            "Failed to copy project files for repo '{}': {}",
                            repo.name,
                            e
                        );
                    });
            }
        }

        let agent_working_dir = Session::find_latest_by_workspace_id(&self.db.pool, workspace.id)
            .await?
            .and_then(|session| session.agent_working_dir);

        if let Err(e) = self
            .file_service
            .copy_files_by_workspace_to_worktree(
                workspace_dir,
                workspace.id,
                agent_working_dir.as_deref(),
            )
            .await
        {
            tracing::warn!("Failed to copy workspace files to workspace: {}", e);
        }

        Ok(())
    }

    /// Create workspace-level CLAUDE.md and AGENTS.md files that import from each repo.
    /// Uses the @import syntax to reference each repo's config files.
    /// Skips creating files if they already exist or if no repos have the source file.
    async fn create_workspace_config_files(
        workspace_dir: &Path,
        repos: &[Repo],
    ) -> Result<(), ContainerError> {
        const CONFIG_FILES: [&str; 2] = ["CLAUDE.md", "AGENTS.md"];

        for config_file in CONFIG_FILES {
            let workspace_config_path = workspace_dir.join(config_file);

            if workspace_config_path.exists() {
                tracing::trace!(
                    "Workspace config file {} already exists, skipping",
                    config_file
                );
                continue;
            }

            let mut import_lines = Vec::new();
            for repo in repos {
                let repo_config_path = workspace_dir.join(&repo.name).join(config_file);
                if repo_config_path.exists() {
                    import_lines.push(format!("@{}/{}", repo.name, config_file));
                }
            }

            if import_lines.is_empty() {
                tracing::trace!(
                    "No repos have {}, skipping workspace config creation",
                    config_file
                );
                continue;
            }

            let content = import_lines.join("\n") + "\n";
            if let Err(e) = tokio::fs::write(&workspace_config_path, &content).await {
                tracing::warn!(
                    "Failed to create workspace config file {}: {}",
                    config_file,
                    e
                );
                continue;
            }

            tracing::info!(
                "Created workspace {} with {} import(s)",
                config_file,
                import_lines.len()
            );
        }

        Ok(())
    }

    /// Start a follow-up execution from a queued message
    async fn start_queued_follow_up(
        &self,
        ctx: &ExecutionContext,
        queued_data: &DraftFollowUpData,
    ) -> Result<ExecutionProcess, ContainerError> {
        let executor_profile_id = queued_data.executor_config.profile_id();

        // Validate executor matches session if session has prior executions
        let expected_executor: Option<String> =
            ExecutionProcess::latest_executor_profile_for_session(&self.db.pool, ctx.session.id)
                .await?
                .map(|profile| profile.executor.to_string())
                .or_else(|| ctx.session.executor.clone());

        if let Some(expected) = expected_executor {
            let actual = executor_profile_id.executor.to_string();
            if expected != actual {
                return Err(SessionError::ExecutorMismatch { expected, actual }.into());
            }
        }

        if ctx.session.executor.is_none() {
            Session::update_executor(
                &self.db.pool,
                ctx.session.id,
                &executor_profile_id.executor.to_string(),
            )
            .await?;
        }

        // Get latest agent turn for session continuity (from coding agent turns)
        let latest_session_info =
            CodingAgentTurn::find_latest_session_info(&self.db.pool, ctx.session.id).await?;

        let repos =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, ctx.workspace.id).await?;
        let cleanup_action = self.cleanup_actions_for_repos(&repos);

        let working_dir = ctx
            .session
            .agent_working_dir
            .as_ref()
            .filter(|dir| !dir.is_empty())
            .cloned();

        // The "Claude Code Headed" agent runs in a detached tmux terminal. The
        // normal user flow (create session -> type prompt) queues that prompt and
        // starts it here, so we must attach the interactive config in this path
        // too — otherwise a Headed session would silently run headless. Mirrors
        // the logic in the `follow_up` route: reuse the existing conversation id
        // (so `--resume` reattaches) for a follow-up, or a fresh uuid for an
        // initial run; the terminal emulator comes from the user config.
        let want_interactive =
            executor_profile_id.executor == executors::executors::BaseCodingAgent::ClaudeCodeHeaded;
        let interactive = if want_interactive {
            let terminal = self.config.read().await.terminal;
            let session_uuid = latest_session_info
                .as_ref()
                .and_then(|info| Uuid::parse_str(&info.session_id).ok())
                .unwrap_or_else(Uuid::new_v4);
            Some(InteractiveTmuxConfig {
                session_uuid,
                terminal,
            })
        } else {
            None
        };

        let action_type = if let Some(info) = latest_session_info {
            ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
                prompt: queued_data.message.clone(),
                session_id: info.session_id,
                reset_to_message_id: None,
                executor_config: queued_data.executor_config.clone(),
                working_dir: working_dir.clone(),
                interactive: interactive.clone(),
            })
        } else {
            ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
                prompt: queued_data.message.clone(),
                executor_config: queued_data.executor_config.clone(),
                working_dir,
                interactive,
            })
        };

        let action = ExecutorAction::new(action_type, cleanup_action.map(Box::new));

        self.start_execution(
            &ctx.workspace,
            &ctx.session,
            &action,
            &ExecutionProcessRunReason::CodingAgent,
        )
        .await
    }
}

fn failure_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(256) // Exit code 1 (shifted by 8 bits)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(1)
    }
}

impl LocalContainerService {
    /// Start an interactive (detached tmux) coding-agent execution: create the
    /// tmux session running Claude's TUI in `current_dir`, attach the chosen
    /// terminal emulator as a viewer, and begin mirroring the transcript into
    /// the execution's MsgStore. Interactive mode currently supports Claude Code
    /// only.
    /// Extract the interactive (detached tmux) config from an execution's
    /// persisted action, erroring with `NotInteractive` if it is not a headed
    /// coding-agent execution.
    fn interactive_config_of(
        execution_process: &ExecutionProcess,
    ) -> Result<InteractiveTmuxConfig, ContainerError> {
        execution_process
            .executor_action()
            .ok()
            .and_then(|action| action.interactive_config().cloned())
            .ok_or(ContainerError::NotInteractive)
    }

    async fn start_detached_tmux(
        &self,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
        cfg: &InteractiveTmuxConfig,
        current_dir: &Path,
        branch: &str,
        env: ExecutionEnv,
    ) -> Result<(), ContainerError> {
        {
            use executors::{executors::CodingAgent, profile::ExecutorConfigs};

            let exec_id = execution_process.id;

            // Resolve the (Claude) executor + the prompt / resume flag.
            let (profile_id, has_overrides, executor_config, prompt, resume) =
                match executor_action.typ() {
                    ExecutorActionType::CodingAgentInitialRequest(req) => (
                        req.executor_config.profile_id(),
                        req.executor_config.has_overrides(),
                        req.executor_config.clone(),
                        req.prompt.clone(),
                        false,
                    ),
                    ExecutorActionType::CodingAgentFollowUpRequest(req) => (
                        req.executor_config.profile_id(),
                        req.executor_config.has_overrides(),
                        req.executor_config.clone(),
                        req.prompt.clone(),
                        true,
                    ),
                    _ => {
                        return Err(ContainerError::Other(anyhow!(
                            "Interactive mode requires a coding-agent action"
                        )));
                    }
                };

            let mut agent = ExecutorConfigs::get_cached()
                .get_coding_agent(&profile_id)
                .ok_or_else(|| {
                    ContainerError::Other(anyhow!(
                        "Unknown executor profile for interactive mode: {profile_id}"
                    ))
                })?;
            if has_overrides {
                agent.apply_overrides(&executor_config);
            }
            let (claude, telegram_channel) = match agent {
                CodingAgent::ClaudeCode(cc) => (cc, false),
                CodingAgent::ClaudeCodeHeaded(cch) => {
                    let telegram_channel = cch.telegram_channel_enabled();
                    (cch.inner, telegram_channel)
                }
                other => {
                    return Err(ContainerError::Other(anyhow!(
                        "Interactive terminal mode currently supports Claude Code only (got {:?})",
                        other
                    )));
                }
            };

            // Headed approval bridge: when the session runs in approvals
            // (Supervised) OR plan mode, gate tool use through a PreToolUse command
            // hook that calls back into vibe-kanban so approvals/questions surface
            // in the web UI (same store/UI as the headless path). Auto/bypass
            // sessions are unaffected. In approvals mode `permission_mode()` returns
            // Default (`--permission-mode=default`) and the deny-list matcher gates
            // everything but read-only tools; in plan mode it returns Plan
            // (`--permission-mode=plan`) and only ExitPlanMode/AskUserQuestion are
            // gated (see `headed_approval_settings`).
            let approvals_enabled = claude.approvals.unwrap_or(false);
            let plan_enabled = claude.plan.unwrap_or(false);
            let bridge_enabled = approvals_enabled || plan_enabled;

            // Build the interactive argv (no -p / stream-json; prompt positional).
            // On an *initial* headed launch with the Telegram channel enabled,
            // extend the seed prompt so the agent reports progress to its
            // per-branch channel; the helper owns the `telegram_channel && !resume`
            // gate, so resumed follow-ups and channel-off sessions get a
            // byte-identical prompt.
            let session_uuid = cfg.session_uuid.to_string();
            let effective_prompt = executors::executors::claude::build_headed_seed_prompt(
                &prompt,
                telegram_channel,
                resume,
                branch,
            );
            let command = claude
                .build_interactive_command(&session_uuid, &effective_prompt, resume)
                .map_err(|e| {
                    ContainerError::Other(anyhow!("Failed to build interactive command: {e}"))
                })?;
            let (program, args) = command
                .into_resolved()
                .await
                .map_err(ContainerError::ExecutorError)?;
            let mut argv = vec![program.to_string_lossy().into_owned()];
            argv.extend(args);

            // When the Telegram channel option is enabled, load the Sombrax dev
            // channel. Inserted just before the trailing positional prompt; the
            // `=value` form keeps the (variadic) flag from swallowing the prompt.
            if telegram_channel {
                let pos = argv.len().saturating_sub(1);
                argv.insert(
                    pos,
                    executors::executors::claude::TELEGRAM_CHANNEL_FLAG.to_string(),
                );
            }

            // Inject the approval hook via `--settings <json>` (two tokens before
            // the positional prompt). The hook command is a self-contained curl
            // with the backend URL baked in — NOT an env var — because a
            // `command` hook is run via `sh -c "$cmd"` and a nested `$VAR` inside
            // would not be re-expanded. The backend port is discovered from the
            // port file the server writes at startup.
            if bridge_enabled {
                match utils::port_file::read_port_file("vibe-kanban").await {
                    Ok(port) => {
                        let url = format!(
                            "http://127.0.0.1:{port}/api/headed-approvals/{exec_id}/request"
                        );
                        let hook_cmd = format!(
                            "curl -sS -X POST {url} --data-binary @- --max-time {}",
                            utils::approvals::APPROVAL_TIMEOUT_SECONDS
                        );
                        let settings = executors::executors::claude::headed_approval_settings(
                            &hook_cmd,
                            plan_enabled,
                        )
                        .to_string();
                        let pos = argv.len().saturating_sub(1);
                        argv.insert(pos, settings);
                        argv.insert(pos, "--settings".to_string());
                    }
                    Err(e) => {
                        // Without the port we cannot wire the bridge; fall back to
                        // the TUI's own prompts rather than failing the spawn.
                        tracing::warn!(
                            "headed approval bridge enabled but backend port unavailable ({e}); \
                             tool approvals/questions will use the in-TUI prompt for {exec_id}"
                        );
                    }
                }
            }

            // Replicate the env the headless spawn injects (profile env +
            // NPM_CONFIG_LOGLEVEL), and unset ANTHROPIC_API_KEY if requested.
            let env = env.with_profile(&claude.cmd);
            let mut env_map = env.vars.clone();
            env_map.insert("NPM_CONFIG_LOGLEVEL".to_string(), "error".to_string());
            let env_remove: Vec<String> = if claude.disable_api_key.unwrap_or(false) {
                vec!["ANTHROPIC_API_KEY".to_string()]
            } else {
                vec![]
            };

            // Create the detached tmux session.
            let tmux_session = interactive::tmux_session_name(exec_id);
            terminal::tmux_new_session(&tmux_session, current_dir, &argv, &env_map, &env_remove)
                .await
                .map_err(|e| ContainerError::Other(anyhow!(e)))?;

            // Surface the session identifier in the server log (plain ASCII).
            // Intentionally NOT pushed into the MsgStore: the transcript tail
            // re-adopts by stdout line offset, so an extra line would desync it.
            tracing::info!(
                "interactive session started: tmux={tmux_session} claude={session_uuid} \
                 attach=`{}`",
                terminal::attach_command(&tmux_session)
            );

            // Attach the chosen terminal emulator as a viewer. A missing emulator
            // is non-fatal: the session is alive and reachable via `tmux attach`.
            let iterm_tabs = self.config.read().await.iterm_tabs;
            if let Err(e) =
                terminal::open_in_terminal(cfg.terminal, &tmux_session, iterm_tabs).await
            {
                tracing::warn!("Could not open terminal emulator for {tmux_session}: {e}");
            }

            // With the Telegram channel enabled, the headed session opens behind
            // up to two confirmation prompts (folder-trust, then the dev-channel
            // warning). Auto-confirm them in the background so the agent reaches
            // the prompt without the operator needing to press Enter manually.
            if telegram_channel {
                let session = tmux_session.clone();
                tokio::spawn(async move {
                    Self::auto_confirm_headed_startup(session).await;
                });
            }

            // Begin mirroring + liveness tracking from the start of the transcript.
            self.attach_detached_tracking(exec_id, current_dir, cfg, 0)
                .await;

            Ok(())
        }
    }

    /// Auto-confirm the headed Claude startup prompts by pressing Enter when each
    /// is detected on screen. Two prompts may appear in sequence:
    ///
    /// 1. the workspace folder-trust check, then
    /// 2. the `--dangerously-load-development-channels` warning.
    ///
    /// We poll the pane and press Enter once per prompt (the safe option is the
    /// highlighted default). Matching is by signature text and pinned to the
    /// Claude version we ship; if the text changes we simply stop confirming
    /// (the operator can still press Enter), never sending a wrong keystroke.
    async fn auto_confirm_headed_startup(tmux_session: String) {
        const TRUST_PROMPT: &str = "Is this a project you";
        const CHANNEL_PROMPT: &str = "Loading development channels";
        const INITIAL_DELAY: Duration = Duration::from_secs(5);
        const POLL_INTERVAL: Duration = Duration::from_millis(500);
        const TIMEOUT: Duration = Duration::from_secs(40);

        // Grace period before the first Enter, so the prompt is fully rendered
        // (and to leave a window for manual interaction).
        tokio::time::sleep(INITIAL_DELAY).await;

        let deadline = Instant::now() + TIMEOUT;
        let mut trust_done = false;
        while Instant::now() < deadline {
            tokio::time::sleep(POLL_INTERVAL).await;
            let pane = match terminal::tmux_capture_pane(&tmux_session).await {
                Ok(pane) => pane,
                // Session gone (or no longer reachable): nothing left to confirm.
                Err(_) => return,
            };

            if !trust_done && pane.contains(TRUST_PROMPT) {
                if terminal::tmux_send_enter(&tmux_session).await.is_err() {
                    return;
                }
                trust_done = true;
                // Let the next screen render before re-inspecting.
                tokio::time::sleep(Duration::from_millis(800)).await;
                continue;
            }

            if pane.contains(CHANNEL_PROMPT) {
                // The channel warning is the last prompt in the sequence; confirm
                // it and we are done.
                let _ = terminal::tmux_send_enter(&tmux_session).await;
                return;
            }
        }
        tracing::warn!(
            "auto-confirm timed out for headed session {tmux_session}; \
             operator may need to press Enter to continue"
        );
    }

    /// Re-establish the live pipeline for a detached execution: load already
    /// persisted transcript lines into a fresh MsgStore for context, restart the
    /// transcript tail at `from_line_offset` (so re-adoption never re-emits or
    /// duplicates persisted lines), and start the liveness poller.
    ///
    /// Called with `from_line_offset == 0` at first start, and with the count of
    /// already-mirrored lines during restart reconciliation.
    async fn attach_detached_tracking(
        &self,
        exec_id: Uuid,
        current_dir: &Path,
        cfg: &InteractiveTmuxConfig,
        from_line_offset: usize,
    ) {
        let tmux_session = interactive::tmux_session_name(exec_id);
        let store = {
            let map = self.msg_stores.read().await;
            map.get(&exec_id).cloned()
        };
        let Some(store) = store else {
            tracing::error!("MsgStore missing for detached execution {exec_id}");
            return;
        };

        // Record the forced Claude session id so follow-ups can `--resume` it.
        store.push_session_id(cfg.session_uuid.to_string());

        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        // Claude derives its transcript directory name from the *canonical* cwd
        // (e.g. macOS `/var/...` -> `/private/var/...`). Our worktree path is the
        // un-resolved symlink path, so canonicalize before encoding or the tail
        // would watch a non-existent file (no agent output, spinner never stops).
        let canonical_dir = tokio::fs::canonicalize(current_dir)
            .await
            .unwrap_or_else(|_| current_dir.to_path_buf());
        let transcript_path =
            interactive::claude_transcript_path(&home, &canonical_dir, cfg.session_uuid);

        let cancel = CancellationToken::new();
        let tail_handle =
            Self::spawn_transcript_tail(store, transcript_path, from_line_offset, cancel.clone());
        let poll_handle = self.spawn_liveness_poller(exec_id, tmux_session.clone(), cancel.clone());

        self.detached_store.write().await.insert(
            exec_id,
            DetachedHandle {
                tmux_session,
                cancel,
                tail_handle,
                poll_handle,
            },
        );
    }

    /// Re-adopt a detached execution whose tmux session survived a restart.
    /// Rebuilds the live pipeline (fresh MsgStore + normalizer + raw-log
    /// persistence) and resumes the transcript tail after the lines already
    /// persisted, so nothing is duplicated. The MsgStore starts empty (history
    /// stays in the persisted JSONL and is served on reload); reconnecting
    /// viewers therefore see post-restart output live and full history on reload.
    async fn readopt_detached(&self, process: &ExecutionProcess, cfg: &InteractiveTmuxConfig) {
        {
            use executors::profile::ExecutorConfigs;

            let exec_id = process.id;
            let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, exec_id).await else {
                tracing::error!("Failed to load context for re-adopting {exec_id}");
                return;
            };
            let workspace_root = self.workspace_to_current_dir(&ctx.workspace);
            let Ok(action) = process.executor_action() else {
                return;
            };
            let (profile_id, effective_dir) = match action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(r) => (
                    r.executor_config.profile_id(),
                    r.effective_dir(&workspace_root),
                ),
                ExecutorActionType::CodingAgentFollowUpRequest(r) => (
                    r.executor_config.profile_id(),
                    r.effective_dir(&workspace_root),
                ),
                _ => return,
            };

            // Fresh empty MsgStore: the normal persister appends only NEW lines
            // (history is empty), so already-persisted lines are not duplicated.
            self.msg_stores
                .write()
                .await
                .insert(exec_id, Arc::new(MsgStore::new()));
            let Some(store) = self.msg_stores.read().await.get(&exec_id).cloned() else {
                return;
            };

            if let Some(executor) = ExecutorConfigs::get_cached().get_coding_agent(&profile_id) {
                let _ = executor.normalize_logs(store, &effective_dir);
            }
            execution_process::spawn_stream_raw_logs_to_storage(
                self.msg_stores.clone(),
                self.db.clone(),
                exec_id,
                ctx.session.id,
            );

            // Resume the transcript tail after the lines already mirrored
            // (= count of persisted Stdout lines).
            let from_line_offset = execution_process::load_raw_log_messages(&self.db.pool, exec_id)
                .await
                .map(|msgs| {
                    msgs.iter()
                        .filter(|m| matches!(m, LogMsg::Stdout(_)))
                        .count()
                })
                .unwrap_or(0);

            self.attach_detached_tracking(exec_id, &effective_dir, cfg, from_line_offset)
                .await;
        }
    }

    /// Tail Claude's transcript JSONL, pushing each newly-appended complete line
    /// into the MsgStore as `LogMsg::Stdout`. The existing Claude `normalize_logs`
    /// pipeline then renders the timeline, and `spawn_stream_raw_logs_to_storage`
    /// persists the lines (so history survives reload). Skips the first
    /// `from_line_offset` complete lines for restart re-adoption.
    fn spawn_transcript_tail(
        store: Arc<MsgStore>,
        path: PathBuf,
        from_line_offset: usize,
        cancel: CancellationToken,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut pos: u64 = 0;
            let mut lines_seen: usize = 0;
            loop {
                if cancel.is_cancelled() {
                    // Final drain pass so trailing lines aren't lost on completion.
                    Self::drain_transcript(
                        &store,
                        &path,
                        &mut pos,
                        &mut lines_seen,
                        from_line_offset,
                    )
                    .await;
                    return;
                }
                Self::drain_transcript(&store, &path, &mut pos, &mut lines_seen, from_line_offset)
                    .await;
                tokio::select! {
                    _ = cancel.cancelled() => {
                        Self::drain_transcript(
                            &store, &path, &mut pos, &mut lines_seen, from_line_offset,
                        )
                        .await;
                        return;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
            }
        })
    }

    /// Read any complete lines appended since byte offset `pos`, pushing those
    /// past `from_line_offset` into the store. Tolerates a not-yet-created file.
    async fn drain_transcript(
        store: &Arc<MsgStore>,
        path: &Path,
        pos: &mut u64,
        lines_seen: &mut usize,
        from_line_offset: usize,
    ) {
        let Ok(file) = tokio::fs::File::open(path).await else {
            return; // not created yet
        };
        let mut reader = BufReader::new(file);
        if reader.seek(std::io::SeekFrom::Start(*pos)).await.is_err() {
            return;
        }
        let mut line = String::new();
        loop {
            line.clear();
            let n = match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(n) => n,
                Err(_) => break,
            };
            if !line.ends_with('\n') {
                // Partial line — leave `pos` before it and wait for more.
                break;
            }
            *pos += n as u64;
            *lines_seen += 1;
            if *lines_seen > from_line_offset {
                store.push(LogMsg::Stdout(line.clone()));
            }
        }
    }

    /// Poll whether the tmux session is still alive; when it ends (and we did not
    /// kill it via `stop_execution`), finalize the execution as completed and run
    /// the same post-completion chain as an owned child exit.
    fn spawn_liveness_poller(
        &self,
        exec_id: Uuid,
        tmux_session: String,
        cancel: CancellationToken,
    ) -> JoinHandle<()> {
        let container = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    // stop_execution owns status + teardown; just exit.
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(DETACHED_POLL_INTERVAL) => {
                        if terminal::tmux_has_session(&tmux_session).await {
                            continue;
                        }
                        // Session ended on its own (user /exit or shell exit).
                        // Give the tail a moment to flush trailing transcript
                        // lines, then stop it and finalize.
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let handle = container.detached_store.write().await.remove(&exec_id);
                        if let Some(h) = handle {
                            h.cancel.cancel();
                        }
                        if !ExecutionProcess::was_stopped(&container.db.pool, exec_id).await {
                            container
                                .finalize_completed_execution(
                                    exec_id,
                                    Some(0),
                                    ExecutionProcessStatus::Completed,
                                )
                                .await;
                        }
                        return;
                    }
                }
            }
        })
    }
}

#[async_trait]
impl ContainerService for LocalContainerService {
    fn msg_stores(&self) -> &Arc<RwLock<HashMap<Uuid, Arc<MsgStore>>>> {
        &self.msg_stores
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn notification_service(&self) -> &NotificationService {
        &self.notification_service
    }

    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    /// On startup, reconcile DB-`running` processes with reality. Detached tmux
    /// executions whose session is still alive are re-adopted (kept running);
    /// detached sessions that ended while we were down are marked completed; all
    /// other orphans are marked failed (the default behavior).
    async fn cleanup_orphan_executions(&self) -> Result<(), ContainerError> {
        let running_processes = ExecutionProcess::find_running(&self.db.pool).await?;
        for process in running_processes {
            // Interactive (detached tmux) executions may have outlived a restart.
            if let Ok(action) = process.executor_action()
                && let Some(cfg) = action.interactive_config().cloned()
            {
                let tmux_session = interactive::tmux_session_name(process.id);
                if terminal::tmux_has_session(&tmux_session).await {
                    tracing::info!("Re-adopting live detached tmux execution {}", process.id);
                    self.readopt_detached(&process, &cfg).await;
                    continue; // leave status = running
                }
                tracing::info!(
                    "Detached tmux session for execution {} is gone; marking completed",
                    process.id
                );
                if let Err(e) = ExecutionProcess::update_completion(
                    &self.db.pool,
                    process.id,
                    ExecutionProcessStatus::Completed,
                    Some(0),
                )
                .await
                {
                    tracing::error!(
                        "Failed to mark ended detached execution {} completed: {}",
                        process.id,
                        e
                    );
                }
                self.update_after_head_commits(process.id).await;
                continue;
            }

            tracing::info!(
                "Found orphaned execution process {} for session {}",
                process.id,
                process.session_id
            );
            if let Err(e) = ExecutionProcess::update_completion(
                &self.db.pool,
                process.id,
                ExecutionProcessStatus::Failed,
                None,
            )
            .await
            {
                tracing::error!(
                    "Failed to update orphaned execution process {} status: {}",
                    process.id,
                    e
                );
                continue;
            }
            if let Ok(ctx) = ExecutionProcess::load_context(&self.db.pool, process.id).await
                && let Some(ref container_ref) = ctx.workspace.container_ref
            {
                let workspace_root = PathBuf::from(container_ref);
                for repo in &ctx.repos {
                    let repo_path = workspace_root.join(&repo.name);
                    if let Ok(head) = self.git.get_head_info(&repo_path)
                        && let Err(err) = ExecutionProcessRepoState::update_after_head_commit(
                            &self.db.pool,
                            process.id,
                            repo.id,
                            &head.oid,
                        )
                        .await
                    {
                        tracing::warn!(
                            "Failed to update after_head_commit for repo {} on process {}: {}",
                            repo.id,
                            process.id,
                            err
                        );
                    }
                }
            }
            tracing::info!("Marked orphaned execution process {} as failed", process.id);
        }
        Ok(())
    }

    async fn touch(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        let now = Instant::now();

        // We debounce touches to avoid excessive database writes, which in SQLites causes DB locks
        let should_debounce = |last_touch: &Instant| -> bool {
            now.duration_since(*last_touch) < WORKSPACE_TOUCH_DEBOUNCE
        };

        // Quick check with read lock
        if self
            .workspace_touch_times
            .read()
            .await
            .get(&workspace.id)
            .is_some_and(should_debounce)
        {
            return Ok(());
        }

        let mut map = self.workspace_touch_times.write().await;
        // Clean up stale entries older than the debounce window, reduce memory usage over time
        map.retain(|_, time| should_debounce(time));
        // check in case another thread has touched already
        if map.get(&workspace.id).is_some_and(should_debounce) {
            return Ok(());
        }
        map.insert(workspace.id, now);
        drop(map);

        Workspace::touch(&self.db.pool, workspace.id).await?;
        Ok(())
    }

    async fn store_db_stream_handle(&self, id: Uuid, handle: JoinHandle<()>) {
        self.add_db_stream_handle(id, handle).await;
    }

    async fn take_db_stream_handle(&self, id: &Uuid) -> Option<JoinHandle<()>> {
        LocalContainerService::take_db_stream_handle(self, id).await
    }

    async fn git_branch_prefix(&self) -> String {
        self.config.read().await.git_branch_prefix.clone()
    }

    fn workspace_to_current_dir(&self, workspace: &Workspace) -> PathBuf {
        PathBuf::from(workspace.container_ref.clone().unwrap_or_default())
    }

    async fn create(&self, workspace: &Workspace) -> Result<ContainerRef, ContainerError> {
        let label = workspace.name.as_deref().unwrap_or("workspace");
        let workspace_dir_name =
            LocalContainerService::dir_name_from_workspace(&workspace.id, label);
        let workspace_dir = WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name);

        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        let created_workspace = WorkspaceManager::create_workspace(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        // Worktrees now exist on disk but `container_ref` is not yet persisted.
        // If the post-worktree steps fail here, the normal deletion path (which
        // reads `container_ref` from the DB) can't find this directory, leaving
        // an orphaned worktree. Clean it up directly on failure to close that
        // window (matters especially for ephemeral spec-intake workspaces).
        let post_worktree: Result<(), ContainerError> = async {
            self.copy_files_and_images(&created_workspace.workspace_dir, workspace)
                .await?;
            Self::create_workspace_config_files(&created_workspace.workspace_dir, &repositories)
                .await?;
            Ok(())
        }
        .await;

        if let Err(e) = post_worktree {
            tracing::error!(
                "Workspace {} setup failed after worktree creation; cleaning up {}: {}",
                workspace.id,
                created_workspace.workspace_dir.display(),
                e
            );
            if let Err(cleanup_err) =
                WorkspaceManager::cleanup_workspace(&created_workspace.workspace_dir, &repositories)
                    .await
            {
                tracing::warn!(
                    "Failed to clean up partially-created workspace {}: {}",
                    workspace.id,
                    cleanup_err
                );
            }
            return Err(e);
        }

        Workspace::update_container_ref(
            &self.db.pool,
            workspace.id,
            &created_workspace.workspace_dir.to_string_lossy(),
        )
        .await?;

        Ok(created_workspace
            .workspace_dir
            .to_string_lossy()
            .to_string())
    }

    async fn delete(&self, workspace: &Workspace) -> Result<(), ContainerError> {
        self.try_stop(workspace, true).await;
        self.cleanup_workspace(workspace).await;
        Ok(())
    }

    async fn ensure_container_exists(
        &self,
        workspace: &Workspace,
    ) -> Result<ContainerRef, ContainerError> {
        self.touch(workspace).await?;
        let (repositories, workspace_inputs) = self.workspace_repo_inputs(workspace.id).await?;

        let workspace_dir = if let Some(container_ref) = &workspace.container_ref {
            PathBuf::from(container_ref)
        } else {
            let label = workspace.name.as_deref().unwrap_or("workspace");
            let workspace_dir_name =
                LocalContainerService::dir_name_from_workspace(&workspace.id, label);
            WorkspaceManager::get_workspace_base_dir().join(&workspace_dir_name)
        };

        WorkspaceManager::ensure_workspace_exists(
            &workspace_dir,
            &workspace_inputs,
            &workspace.branch,
        )
        .await
        .map_err(Self::map_workspace_manager_error)?;

        if workspace.container_ref.is_none() {
            Workspace::update_container_ref(
                &self.db.pool,
                workspace.id,
                &workspace_dir.to_string_lossy(),
            )
            .await?;
        }

        if workspace.worktree_deleted {
            Workspace::clear_worktree_deleted(&self.db.pool, workspace.id).await?;
        }

        // Copy project files and images (fast no-op if already exist)
        self.copy_files_and_images(&workspace_dir, workspace)
            .await?;

        Self::create_workspace_config_files(&workspace_dir, &repositories).await?;

        Ok(workspace_dir.to_string_lossy().to_string())
    }

    async fn is_container_clean(&self, workspace: &Workspace) -> Result<bool, ContainerError> {
        let Some(container_ref) = &workspace.container_ref else {
            return Ok(true);
        };

        let workspace_dir = PathBuf::from(container_ref);
        if !workspace_dir.exists() {
            return Ok(true);
        }

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        for repo in &repositories {
            let worktree_path = workspace_dir.join(&repo.name);
            if worktree_path.exists() {
                let (uncommitted, untracked) =
                    self.git().get_worktree_change_counts(&worktree_path)?;
                if uncommitted > 0 || untracked > 0 {
                    return Ok(false);
                }
            }
        }

        Ok(true)
    }

    async fn start_execution_inner(
        &self,
        workspace: &Workspace,
        execution_process: &ExecutionProcess,
        executor_action: &ExecutorAction,
    ) -> Result<(), ContainerError> {
        // Get the worktree path
        let container_ref = workspace
            .container_ref
            .as_ref()
            .ok_or(ContainerError::Other(anyhow!(
                "Container ref not found for workspace"
            )))?;
        let current_dir = PathBuf::from(container_ref);

        let approvals_service: Arc<dyn ExecutorApprovalService> =
            match executor_action.base_executor() {
                Some(
                    BaseCodingAgent::Codex
                    | BaseCodingAgent::ClaudeCode
                    | BaseCodingAgent::Gemini
                    | BaseCodingAgent::QwenCode
                    | BaseCodingAgent::Opencode,
                ) => ExecutorApprovalBridge::new(
                    self.approvals.clone(),
                    self.db.clone(),
                    self.notification_service.clone(),
                    execution_process.id,
                ),
                _ => Arc::new(NoopExecutorApprovalService {}),
            };

        let repos = WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;
        let repo_names: Vec<String> = repos.iter().map(|r| r.name.clone()).collect();
        let repo_context = RepoContext::new(current_dir.clone(), repo_names);

        let config = self.config.read().await;
        let commit_reminder_enabled = config.commit_reminder_enabled;
        let commit_reminder_prompt = config
            .commit_reminder_prompt
            .clone()
            .unwrap_or_else(|| DEFAULT_COMMIT_REMINDER_PROMPT.to_string());
        drop(config);
        let mut env = ExecutionEnv::new(
            repo_context,
            commit_reminder_enabled,
            commit_reminder_prompt,
        );

        // Always inject workspace/session context
        env.insert("VK_WORKSPACE_ID", workspace.id.to_string());
        env.insert("VK_WORKSPACE_BRANCH", &workspace.branch);

        // Telegram channel: hand Claude Code agents their per-branch channel
        // *name* via TELEGRAM_TOPIC, plus TELEGRAM_DEV=1 marking the session as
        // the channel's dev agent (kind=dev, role=owner in sombrax-telegram's
        // role model). Without this flag the agent registers as a passive
        // observer and never owns its channel. VK holds no bot token and passes
        // no chat id — the sombrax listener resolves/creates the forum topic
        // from the name and resolves the chat itself, owning all Bot API I/O.
        if matches!(
            executor_action.base_executor(),
            Some(BaseCodingAgent::ClaudeCode | BaseCodingAgent::ClaudeCodeHeaded)
        ) && utils::telegram_topics::per_worktree_enabled()
        {
            env.insert("TELEGRAM_TOPIC", &workspace.branch);
            env.insert("TELEGRAM_DEV", "1");
        }

        // Interactive (detached tmux) path: run the agent's TUI in a tmux
        // session instead of a headless child. The shared `start_execution`
        // wrapper still creates the MsgStore + turn and wires up `normalize_logs`
        // and raw-log persistence, so we only need to launch the session and
        // start mirroring its transcript here.
        if let Some(cfg) = executor_action.interactive_config() {
            let effective_dir = match executor_action.typ() {
                ExecutorActionType::CodingAgentInitialRequest(req) => {
                    req.effective_dir(&current_dir)
                }
                ExecutorActionType::CodingAgentFollowUpRequest(req) => {
                    req.effective_dir(&current_dir)
                }
                _ => current_dir.clone(),
            };
            return self
                .start_detached_tmux(
                    execution_process,
                    executor_action,
                    cfg,
                    &effective_dir,
                    &workspace.branch,
                    env,
                )
                .await;
        }

        // Create the child and stream, add to execution tracker with timeout
        let mut spawned = tokio::time::timeout(
            Duration::from_secs(30),
            executor_action.spawn(&current_dir, approvals_service, &env),
        )
        .await
        .map_err(|_| {
            ContainerError::Other(anyhow!(
                "Timeout: process took more than 30 seconds to start"
            ))
        })??;

        if let Err(e) = self
            .track_child_msgs_in_store(execution_process.id, &mut spawned.child)
            .await
        {
            let _ = command::kill_process_group(&mut spawned.child).await;
            return Err(e);
        }

        self.add_child_to_store(execution_process.id, spawned.child)
            .await;

        // Store cancellation token for graceful shutdown
        if let Some(cancel) = spawned.cancel {
            self.add_cancellation_token(execution_process.id, cancel)
                .await;
        }

        // Spawn unified exit monitor: watches OS exit and optional executor signal
        let hn = self.spawn_exit_monitor(&execution_process.id, spawned.exit_signal);
        self.add_exit_monitor_handle(execution_process.id, hn).await;

        Ok(())
    }

    async fn stop_execution(
        &self,
        execution_process: &ExecutionProcess,
        status: ExecutionProcessStatus,
    ) -> Result<(), ContainerError> {
        // Detached tmux execution: kill the tmux session instead of a child
        // process group. Status is written BEFORE cancelling the poller so a
        // racing liveness tick sees `was_stopped() == true` and does nothing.
        if let Some(handle) = self
            .detached_store
            .write()
            .await
            .remove(&execution_process.id)
        {
            let exit_code = if status == ExecutionProcessStatus::Completed {
                Some(0)
            } else {
                None
            };
            ExecutionProcess::update_completion(
                &self.db.pool,
                execution_process.id,
                status,
                exit_code,
            )
            .await?;

            handle.cancel.cancel();
            if let Err(e) = terminal::tmux_kill_session(&handle.tmux_session).await {
                tracing::warn!("Failed to kill tmux session {}: {}", handle.tmux_session, e);
            }
            // Stop the tail/poller tasks promptly.
            handle.tail_handle.abort();
            handle.poll_handle.abort();

            // Tear down MsgStore + db stream exactly like the owned-child path.
            let db_stream_handle = self.take_db_stream_handle(&execution_process.id).await;
            if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
                msg.push_finished();
            }
            if let Some(handle) = db_stream_handle {
                let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
            }

            self.update_after_head_commits(execution_process.id).await;
            tracing::debug!(
                "Detached execution {} stopped successfully",
                execution_process.id
            );
            return Ok(());
        }

        let child = self
            .get_child_from_store(&execution_process.id)
            .await
            .ok_or_else(|| {
                ContainerError::Other(anyhow!("Child process not found for execution"))
            })?;
        let exit_code = if status == ExecutionProcessStatus::Completed {
            Some(0)
        } else {
            None
        };

        ExecutionProcess::update_completion(&self.db.pool, execution_process.id, status, exit_code)
            .await?;

        // Try graceful cancellation first, then force kill
        if let Some(cancel) = self.take_cancellation_token(&execution_process.id).await {
            cancel.cancel();

            // Wait for exit monitor to finish gracefully
            if let Some(monitor_handle) = self.take_exit_monitor_handle(&execution_process.id).await
            {
                match tokio::time::timeout(Duration::from_secs(5), monitor_handle).await {
                    Ok(_) => {
                        tracing::debug!("Process {} exited gracefully", execution_process.id);
                    }
                    Err(_) => {
                        tracing::debug!(
                            "Graceful shutdown timed out for process {}, force killing",
                            execution_process.id
                        );
                    }
                }
            }
        }

        {
            let mut child_guard = child.write().await;
            if let Err(e) = command::kill_process_group(&mut child_guard).await {
                tracing::error!(
                    "Failed to stop execution process {}: {}",
                    execution_process.id,
                    e
                );
                return Err(e);
            }
        }
        self.remove_child_from_store(&execution_process.id).await;

        // Mark the process finished in the MsgStore and wait for DB persistence
        let db_stream_handle = self.take_db_stream_handle(&execution_process.id).await;
        if let Some(msg) = self.msg_stores.write().await.remove(&execution_process.id) {
            msg.push_finished();
        }
        if let Some(handle) = db_stream_handle {
            let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
        }

        tracing::debug!(
            "Execution process {} stopped successfully",
            execution_process.id
        );

        // Record after-head commit OID (best-effort)
        self.update_after_head_commits(execution_process.id).await;

        Ok(())
    }

    async fn open_interactive_terminal(
        &self,
        execution_process: &ExecutionProcess,
    ) -> Result<(), ContainerError> {
        let cfg = Self::interactive_config_of(execution_process)?;
        let tmux_session = interactive::tmux_session_name(execution_process.id);
        if !terminal::tmux_has_session(&tmux_session).await {
            return Err(ContainerError::InteractiveSessionGone);
        }
        let iterm_tabs = self.config.read().await.iterm_tabs;
        terminal::open_in_terminal(cfg.terminal, &tmux_session, iterm_tabs)
            .await
            .map_err(|e| match e {
                terminal::TerminalError::TerminalUnavailable { attach_cmd, .. } => {
                    ContainerError::TerminalUnavailable(attach_cmd)
                }
                other => ContainerError::Other(anyhow!(other)),
            })
    }

    async fn send_interactive_input(
        &self,
        execution_process: &ExecutionProcess,
        text: &str,
    ) -> Result<(), ContainerError> {
        // Confirm this is an interactive execution (ignore the config payload).
        Self::interactive_config_of(execution_process)?;
        let tmux_session = interactive::tmux_session_name(execution_process.id);
        if !terminal::tmux_has_session(&tmux_session).await {
            return Err(ContainerError::InteractiveSessionGone);
        }
        terminal::tmux_send_keys(&tmux_session, text)
            .await
            .map_err(|e| match e {
                terminal::TerminalError::SessionGone(_) => ContainerError::InteractiveSessionGone,
                other => ContainerError::Other(anyhow!(other)),
            })
    }

    async fn send_interactive_message(
        &self,
        execution_process: &ExecutionProcess,
        text: &str,
    ) -> Result<(), ContainerError> {
        // Confirm this is an interactive execution (ignore the config payload).
        Self::interactive_config_of(execution_process)?;
        let tmux_session = interactive::tmux_session_name(execution_process.id);
        if !terminal::tmux_has_session(&tmux_session).await {
            return Err(ContainerError::InteractiveSessionGone);
        }
        terminal::tmux_paste_message(&tmux_session, text)
            .await
            .map_err(|e| match e {
                terminal::TerminalError::SessionGone(_) => ContainerError::InteractiveSessionGone,
                other => ContainerError::Other(anyhow!(other)),
            })
    }

    async fn is_interactive_session_live(&self, execution_process: &ExecutionProcess) -> bool {
        // Only headed (interactive) executions have a tmux session to be live.
        if Self::interactive_config_of(execution_process).is_err() {
            return false;
        }
        let tmux_session = interactive::tmux_session_name(execution_process.id);
        terminal::tmux_has_session(&tmux_session).await
    }

    async fn stream_diff(
        &self,
        workspace: &Workspace,
        stats_only: bool,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogMsg, std::io::Error>>, ContainerError>
    {
        let workspace_repos =
            WorkspaceRepo::find_by_workspace_id(&self.db.pool, workspace.id).await?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|wr| (wr.repo_id, wr.target_branch.clone()))
            .collect();

        let repositories =
            WorkspaceRepo::find_repos_for_workspace(&self.db.pool, workspace.id).await?;

        let mut streams = Vec::new();

        let container_ref = self.ensure_container_exists(workspace).await?;
        let workspace_root = PathBuf::from(container_ref);

        for repo in repositories {
            let worktree_path = workspace_root.join(&repo.name);
            let branch = &workspace.branch;

            let Some(target_branch) = target_branches.get(&repo.id) else {
                tracing::warn!(
                    "Skipping diff stream for repo {}: no target branch configured",
                    repo.name
                );
                continue;
            };

            let base_commit = match self
                .git()
                .get_base_commit(&repo.path, branch, target_branch)
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(
                        "Skipping diff stream for repo {}: failed to get base commit: {}",
                        repo.name,
                        e
                    );
                    continue;
                }
            };

            let stream = self
                .create_live_diff_stream(diff_stream::DiffStreamArgs {
                    git_service: self.git().clone(),
                    db: self.db().clone(),
                    workspace_id: workspace.id,
                    repo_id: repo.id,
                    repo_path: repo.path.clone(),
                    worktree_path: worktree_path.clone(),
                    branch: branch.to_string(),
                    target_branch: target_branch.clone(),
                    base_commit: base_commit.clone(),
                    stats_only,
                    path_prefix: Some(repo.name.clone()),
                })
                .await?;

            streams.push(Box::pin(stream));
        }

        if streams.is_empty() {
            return Ok(Box::pin(futures::stream::empty()));
        }

        // Merge all streams into one
        Ok(Box::pin(futures::stream::select_all(streams)))
    }

    async fn try_commit_changes(&self, ctx: &ExecutionContext) -> Result<bool, ContainerError> {
        if !matches!(
            ctx.execution_process.run_reason,
            ExecutionProcessRunReason::CodingAgent | ExecutionProcessRunReason::CleanupScript,
        ) {
            return Ok(false);
        }

        let message = self.get_commit_message(ctx).await;

        let container_ref = ctx
            .workspace
            .container_ref
            .as_ref()
            .ok_or_else(|| ContainerError::Other(anyhow!("Container reference not found")))?;
        let workspace_root = PathBuf::from(container_ref);

        let repos_with_changes = self.check_repos_for_changes(&workspace_root, &ctx.repos)?;
        if repos_with_changes.is_empty() {
            tracing::debug!("No changes to commit in any repository");
            return Ok(false);
        }

        Ok(self.commit_repos(repos_with_changes, &message))
    }

    /// Copy files from the original project directory to the worktree.
    /// Skips files that already exist at target with same size.
    async fn copy_project_files(
        &self,
        source_dir: &Path,
        target_dir: &Path,
        copy_files: &str,
    ) -> Result<(), ContainerError> {
        let source_dir = source_dir.to_path_buf();
        let target_dir = target_dir.to_path_buf();
        let copy_files = copy_files.to_string();

        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::task::spawn_blocking(move || {
                copy::copy_project_files_impl(&source_dir, &target_dir, &copy_files)
            }),
        )
        .await
        .map_err(|_| ContainerError::Other(anyhow!("Copy project files timed out after 30s")))?
        .map_err(|e| ContainerError::Other(anyhow!("Copy files task failed: {e}")))?
    }

    async fn kill_all_running_processes(&self) -> Result<(), ContainerError> {
        tracing::info!("Killing all running processes");

        // Detached tmux sessions intentionally OUTLIVE a vibe-kanban shutdown so
        // they can be re-adopted on restart. Here (shutdown path) we only cancel
        // their in-memory tail/poller tasks; we do NOT kill the tmux session or
        // change their DB status. Explicit per-execution stop still kills them.
        let detached_ids: std::collections::HashSet<Uuid> = {
            let mut map = self.detached_store.write().await;
            let ids: std::collections::HashSet<Uuid> = map.keys().copied().collect();
            for (_, handle) in map.drain() {
                handle.cancel.cancel();
                handle.tail_handle.abort();
                handle.poll_handle.abort();
            }
            ids
        };

        let running_processes = ExecutionProcess::find_running(&self.db.pool).await?;

        tracing::info!(
            "Found {} running processes to kill ({} detached preserved)",
            running_processes.len(),
            detached_ids.len()
        );

        for process in running_processes {
            if detached_ids.contains(&process.id) {
                tracing::info!(
                    "Preserving detached tmux execution {} across shutdown",
                    process.id
                );
                continue;
            }
            tracing::info!(
                "Killing process: id={}, run_reason={:?}",
                process.id,
                process.run_reason
            );
            if let Err(error) = self
                .stop_execution(&process, ExecutionProcessStatus::Killed)
                .await
            {
                tracing::error!(
                    "Failed to cleanly kill running execution process {:?}: {:?}",
                    process,
                    error
                );
            } else {
                tracing::info!("Successfully killed process: id={}", process.id);
            }
        }

        Ok(())
    }
}
fn success_exit_status() -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        ExitStatusExt::from_raw(0)
    }
}
