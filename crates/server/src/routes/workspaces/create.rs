use std::collections::HashSet;

use axum::{Json, extract::State, response::Json as ResponseJson};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    issue::Issue,
    issue_workspace::IssueWorkspace,
    repo::Repo,
    requests::{
        CloseOrchestratorResponse, CreateAndStartWorkspaceRequest, CreateAndStartWorkspaceResponse,
        CreateWorkspaceApiRequest, SpawnOrchestratorRequest, SpawnOrchestratorResponse,
        WorkspaceRepoInput,
    },
    scratch::{DraftWorkspaceRepo, Scratch, ScratchPayload, ScratchType},
    workspace::{CreateWorkspace, Workspace, WorkspaceKind},
};
use deployment::Deployment;
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use services::services::container::ContainerService;
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::WorkspaceError;

use crate::{DeploymentImpl, error::ApiError};

pub(crate) async fn create_workspace_record(
    deployment: &DeploymentImpl,
    name: Option<String>,
    kind: Option<WorkspaceKind>,
) -> Result<Workspace, ApiError> {
    let workspace_id = Uuid::new_v4();
    let branch_label = name
        .as_deref()
        .filter(|branch_label| !branch_label.is_empty())
        .unwrap_or("workspace");
    let git_branch_name = deployment
        .container()
        .git_branch_from_workspace(&workspace_id, branch_label)
        .await;

    let workspace = Workspace::create(
        &deployment.db().pool,
        &CreateWorkspace {
            branch: git_branch_name,
            name: name.filter(|workspace_name| !workspace_name.is_empty()),
            kind,
        },
        workspace_id,
    )
    .await?;

    Ok(workspace)
}

pub async fn create_workspace(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateWorkspaceApiRequest>,
) -> Result<ResponseJson<ApiResponse<Workspace>>, ApiError> {
    let workspace = create_workspace_record(&deployment, payload.name, None).await?;

    Ok(ResponseJson(ApiResponse::success(workspace)))
}

/// Project default repos (from the `PROJECT_REPO_DEFAULTS` scratch — the same
/// source the web UI's create flow reads) that the caller did not already
/// supply and that still exist, as `WorkspaceRepoInput`s on their configured
/// target branch. Dedup is by `repo_id` (caller entries always win, and each
/// `repo_id` is emitted at most once even if the scratch lists it twice), so a
/// repo is never attached twice; stale repo ids (no longer in
/// `existing_repo_ids`) are skipped, mirroring the UI's
/// `getValidProjectRepoDefaults` filter.
fn sibling_repo_inputs(
    caller_repos: &[WorkspaceRepoInput],
    project_defaults: &[DraftWorkspaceRepo],
    existing_repo_ids: &HashSet<Uuid>,
) -> Vec<WorkspaceRepoInput> {
    let mut seen: HashSet<Uuid> = caller_repos.iter().map(|r| r.repo_id).collect();
    project_defaults
        .iter()
        .filter(|d| existing_repo_ids.contains(&d.repo_id))
        .filter(|d| seen.insert(d.repo_id))
        .map(|d| WorkspaceRepoInput {
            repo_id: d.repo_id,
            target_branch: d.target_branch.clone(),
        })
        .collect()
}

fn normalize_prompt(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub async fn create_and_start_workspace(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<CreateAndStartWorkspaceRequest>,
) -> Result<ResponseJson<ApiResponse<CreateAndStartWorkspaceResponse>>, ApiError> {
    let CreateAndStartWorkspaceRequest {
        name,
        repos,
        linked_issue,
        executor_config,
        prompt,
        attachment_ids,
        kind,
    } = payload;

    let workspace_prompt = normalize_prompt(&prompt).ok_or_else(|| {
        ApiError::BadRequest(
            "A workspace prompt is required. Provide a non-empty `prompt`.".to_string(),
        )
    })?;

    if repos.is_empty() {
        return Err(ApiError::BadRequest(
            "At least one repository is required".to_string(),
        ));
    }

    let mut managed_workspace = deployment
        .workspace_manager()
        .load_managed_workspace(create_workspace_record(&deployment, name, kind).await?)
        .await?;

    let pool = &deployment.db().pool;

    // Resolve the linked issue once (read-only). Feeds Fix 1 (link) and Fix 2 (repo union).
    let linked_local_issue = match &linked_issue {
        Some(li) => match Issue::find_by_id(pool, li.issue_id).await? {
            Some(issue) => Some(issue),
            None => {
                tracing::warn!(
                    "linked issue {} not found locally; skipping issue<->workspace link and project-repo expansion",
                    li.issue_id
                );
                None
            }
        },
        None => None,
    };

    // Fix 2: expand an issue-linked workspace to the project's full default repo
    // set so sibling path-dependency repos are mounted even when the caller
    // supplied only one. The source is the `PROJECT_REPO_DEFAULTS` scratch — the
    // same set the web UI's create flow reads — so MCP/orchestrator starts match
    // UI starts. Applies to every linked-issue workspace; the union is deduped by
    // `repo_id` (caller entries win), so it's a no-op when the caller already
    // sent the full set. Scratch read/parse failures degrade to no expansion.
    let sibling_repos: Vec<WorkspaceRepoInput> = match &linked_local_issue {
        Some(issue) => {
            match Scratch::find_by_id(pool, issue.project_id, &ScratchType::ProjectRepoDefaults)
                .await
            {
                Ok(Some(Scratch {
                    payload: ScratchPayload::ProjectRepoDefaults(defaults),
                    ..
                })) => {
                    let default_ids: Vec<Uuid> = defaults.repos.iter().map(|r| r.repo_id).collect();
                    let existing_repo_ids: HashSet<Uuid> = Repo::find_by_ids(pool, &default_ids)
                        .await?
                        .into_iter()
                        .map(|r| r.id)
                        .collect();
                    sibling_repo_inputs(&repos, &defaults.repos, &existing_repo_ids)
                }
                Ok(_) => Vec::new(),
                Err(e) => {
                    tracing::warn!(
                        "failed to read project repo defaults for project {} (skipping expansion): {}",
                        issue.project_id,
                        e
                    );
                    Vec::new()
                }
            }
        }
        None => Vec::new(),
    };

    for repo in &repos {
        managed_workspace
            .add_repository(repo, deployment.git())
            .await
            .map_err(ApiError::from)?;
    }

    for repo in &sibling_repos {
        match managed_workspace
            .add_repository(repo, deployment.git())
            .await
        {
            Ok(()) => {}
            Err(WorkspaceError::BranchNotFound { repo_name, branch }) => {
                tracing::warn!(
                    "skipping project sibling repo {} (branch '{}' not found): expanding project scope best-effort",
                    repo_name,
                    branch
                );
            }
            Err(e) => return Err(ApiError::from(e)),
        }
    }

    if let Some(ids) = &attachment_ids {
        managed_workspace.associate_attachments(ids).await?;
    }

    let workspace = managed_workspace.workspace.clone();
    tracing::info!("Created workspace {}", workspace.id);

    // Fix 1: create the local issue<->workspace link before the terminal tab
    // opens (inside `start_workspace`) so `interactive_tab_title` finds it and
    // titles the tab from the card instead of falling back to the branch. All
    // hard-fail work (caller repos, attachments) has already succeeded by this
    // point, so a failed start never leaves a workspace linked.
    if let Some(issue) = &linked_local_issue
        && let Err(e) = IssueWorkspace::link(pool, issue.id, workspace.id).await
    {
        tracing::warn!(
            "failed to link workspace {} to issue {} before start (tab title falls back to branch): {}",
            workspace.id,
            issue.id,
            e
        );
    }

    let execution_process = deployment
        .container()
        .start_workspace(&workspace, executor_config.clone(), workspace_prompt)
        .await?;

    Ok(ResponseJson(ApiResponse::success(
        CreateAndStartWorkspaceResponse {
            workspace,
            execution_process,
        },
    )))
}

/// Build the executor config for the orchestrator: a headed coding-agent session
/// (its default profile skips permission prompts), launched as the plugin's own
/// session agent (`--agent vibe-kanban-indie:orchestrator`).
///
/// The plugin's SINGLE-LOOP orchestrator owns the whole tick itself (monitor-first
/// two-mode loop) — the retired `sweeper` subagent no longer exists, so the old
/// default-agent workaround (which existed only so a loop-manager brief could spawn
/// `vibe-kanban-indie:sweeper` as a sibling subagent) is gone with it. The agent's
/// full behavior lives in the plugin's `agents/orchestrator.md`; the `/loop` body
/// the caller composes (see `composeOrchestratorPrompt`) is only the short per-tick
/// pointer, matching the plugin's own launcher (`scripts/orchestrator.sh`).
///
/// The headed `executor` backend is parameterized (defaulting to Claude Code
/// Headed in the caller) so the orchestrator can later run on OpenCode Headed.
/// Today the `agent_id` targets the Claude plugin orchestrator, so only the
/// Claude backend is actually exercised — the OpenCode backend remains
/// intentionally inert until its orchestrator is built.
fn orchestrator_executor_config(executor: BaseCodingAgent) -> ExecutorConfig {
    ExecutorConfig {
        executor,
        variant: None,
        model_id: None,
        agent_id: Some("vibe-kanban-indie:orchestrator".to_string()),
        reasoning_id: None,
        permission_policy: None,
    }
}

/// Spawn (or reuse) the singleton orchestrator.
///
/// The orchestrator is repo-independent and runs from a fixed
/// `~/.vibe-kanban/orchestrator` folder. There is at most one active
/// orchestrator workspace:
/// - if one is already running, its live tmux session is reused (`reused: true`);
/// - if one exists but is idle, a fresh session is started on it;
/// - otherwise the singleton workspace is created and started.
pub async fn spawn_orchestrator(
    State(deployment): State<DeploymentImpl>,
    Json(payload): Json<SpawnOrchestratorRequest>,
) -> Result<ResponseJson<ApiResponse<SpawnOrchestratorResponse>>, ApiError> {
    let prompt = normalize_prompt(&payload.prompt)
        .ok_or_else(|| ApiError::BadRequest("An orchestrator prompt is required.".to_string()))?;
    let name = payload
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Orchestrator".to_string());
    // Resolve the headed backend: default to Claude Code Headed; any non-headed
    // value (or omission) falls back to it so the orchestrator always runs headed.
    let executor = payload
        .executor
        .filter(|e| e.is_headed())
        .unwrap_or(BaseCodingAgent::ClaudeCodeHeaded);
    let executor_config = orchestrator_executor_config(executor);

    let pool = &deployment.db().pool;

    // Singleton: at most one active orchestrator workspace.
    if let Some(existing) = Workspace::find_orchestrator(pool).await? {
        // Reuse only when a headed coding-agent session is *genuinely* live.
        // The DB `running` status lags behind a tmux session that ended
        // out-of-band (Claude exited, the `/loop` finished, or it crashed), so
        // attaching on the strength of the DB alone would drop the user into a
        // dead session. Confirm the tmux session itself is alive instead.
        let candidate =
            ExecutionProcess::find_latest_running_coding_agent_for_workspace(pool, existing.id)
                .await?;
        let live = match &candidate {
            Some(proc) => {
                deployment
                    .container()
                    .is_interactive_session_live(proc)
                    .await
            }
            None => false,
        };

        if live {
            // A session is already live — reuse its tmux session.
            return Ok(ResponseJson(ApiResponse::success(
                SpawnOrchestratorResponse {
                    workspace: existing,
                    reused: true,
                },
            )));
        }

        // DB still marks a coding-agent process running even though its tmux
        // session is gone; finalize it so the respawn starts from a clean slate
        // (and the liveness poller doesn't later double-finalize it).
        if let Some(stale) = candidate
            && let Err(e) = deployment
                .container()
                .stop_execution(&stale, ExecutionProcessStatus::Completed)
                .await
        {
            tracing::warn!(
                "Failed to finalize stale orchestrator process {}: {}",
                stale.id,
                e
            );
        }

        // Idle or dead tmux: start a fresh session (and thus a fresh tmux) on
        // the same singleton workspace.
        deployment
            .container()
            .start_workspace(&existing, executor_config.clone(), prompt)
            .await?;
        let workspace = Workspace::find_by_id(pool, existing.id)
            .await?
            .unwrap_or(existing);
        return Ok(ResponseJson(ApiResponse::success(
            SpawnOrchestratorResponse {
                workspace,
                reused: false,
            },
        )));
    }

    // None exists — create the singleton orchestrator workspace and start it.
    // `branch` is just a label here; no git worktree is ever created for it.
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            branch: "orchestrator".to_string(),
            name: Some(name),
            kind: Some(WorkspaceKind::Orchestrator),
        },
        Uuid::new_v4(),
    )
    .await?;

    deployment
        .container()
        .start_workspace(&workspace, executor_config, prompt)
        .await?;

    let workspace = Workspace::find_by_id(pool, workspace.id)
        .await?
        .unwrap_or(workspace);

    Ok(ResponseJson(ApiResponse::success(
        SpawnOrchestratorResponse {
            workspace,
            reused: false,
        },
    )))
}

/// Close the singleton orchestrator: stop its live headed session (killing the
/// tmux session) so the next spawn starts fresh. The singleton workspace itself
/// is preserved for reuse. No-op (`closed: false`) when no orchestrator — or no
/// running session — exists.
pub async fn close_orchestrator(
    State(deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<CloseOrchestratorResponse>>, ApiError> {
    let pool = &deployment.db().pool;

    let Some(existing) = Workspace::find_orchestrator(pool).await? else {
        return Ok(ResponseJson(ApiResponse::success(
            CloseOrchestratorResponse { closed: false },
        )));
    };

    let Some(process) =
        ExecutionProcess::find_latest_running_coding_agent_for_workspace(pool, existing.id).await?
    else {
        return Ok(ResponseJson(ApiResponse::success(
            CloseOrchestratorResponse { closed: false },
        )));
    };

    // Stop the headed session, killing its tmux session. If the tmux session
    // already vanished (so there's no tracked handle to stop), the process is
    // effectively gone already — finalize the DB record directly so it stops
    // reporting as running.
    if let Err(e) = deployment
        .container()
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
    {
        tracing::warn!(
            "stop_execution failed for orchestrator process {}: {}; marking killed",
            process.id,
            e
        );
        ExecutionProcess::update_completion(pool, process.id, ExecutionProcessStatus::Killed, None)
            .await?;
    }

    Ok(ResponseJson(ApiResponse::success(
        CloseOrchestratorResponse { closed: true },
    )))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use db::models::{requests::WorkspaceRepoInput, scratch::DraftWorkspaceRepo};
    use uuid::Uuid;

    use super::sibling_repo_inputs;

    fn default_repo(id: Uuid, target_branch: &str) -> DraftWorkspaceRepo {
        DraftWorkspaceRepo {
            repo_id: id,
            target_branch: target_branch.to_string(),
        }
    }

    #[test]
    fn sibling_repo_inputs_includes_existing_default_not_supplied_by_caller() {
        let sibling_id = Uuid::new_v4();
        let defaults = vec![default_repo(sibling_id, "main")];
        let existing: HashSet<Uuid> = [sibling_id].into_iter().collect();

        let result = sibling_repo_inputs(&[], &defaults, &existing);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].repo_id, sibling_id);
        assert_eq!(result[0].target_branch, "main");
    }

    #[test]
    fn sibling_repo_inputs_excludes_repo_already_supplied_by_caller() {
        let repo_id = Uuid::new_v4();
        let defaults = vec![default_repo(repo_id, "main")];
        let existing: HashSet<Uuid> = [repo_id].into_iter().collect();
        let caller_repos = vec![WorkspaceRepoInput {
            repo_id,
            target_branch: "feature".to_string(),
        }];

        let result = sibling_repo_inputs(&caller_repos, &defaults, &existing);

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_skips_stale_default_not_in_existing_repos() {
        let stale_id = Uuid::new_v4();
        let defaults = vec![default_repo(stale_id, "main")];
        let existing: HashSet<Uuid> = HashSet::new();

        let result = sibling_repo_inputs(&[], &defaults, &existing);

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_empty_defaults_yields_empty() {
        let result = sibling_repo_inputs(&[], &[], &HashSet::new());

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_dedups_duplicate_default_entries() {
        let sibling_id = Uuid::new_v4();
        let defaults = vec![
            default_repo(sibling_id, "main"),
            default_repo(sibling_id, "other"),
        ];
        let existing: HashSet<Uuid> = [sibling_id].into_iter().collect();

        let result = sibling_repo_inputs(&[], &defaults, &existing);

        // Emitted exactly once (first occurrence wins), so it is never attached twice.
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].repo_id, sibling_id);
        assert_eq!(result[0].target_branch, "main");
    }

    #[test]
    fn sibling_repo_inputs_caller_only_repo_not_in_defaults_is_unaffected() {
        let sibling_id = Uuid::new_v4();
        let defaults = vec![default_repo(sibling_id, "main")];
        let existing: HashSet<Uuid> = [sibling_id].into_iter().collect();
        let caller_only_repo = Uuid::new_v4();
        let caller_repos = vec![WorkspaceRepoInput {
            repo_id: caller_only_repo,
            target_branch: "feature".to_string(),
        }];

        let result = sibling_repo_inputs(&caller_repos, &defaults, &existing);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].repo_id, sibling_id);
        assert_eq!(result[0].target_branch, "main");
    }
}
