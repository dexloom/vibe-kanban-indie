use std::collections::{HashMap, HashSet};

use axum::{Json, extract::State, response::Json as ResponseJson};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    issue::Issue,
    issue_workspace::IssueWorkspace,
    project_repo::ProjectRepo,
    repo::Repo,
    requests::{
        CloseOrchestratorResponse, CreateAndStartWorkspaceRequest, CreateAndStartWorkspaceResponse,
        CreateWorkspaceApiRequest, SpawnOrchestratorRequest, SpawnOrchestratorResponse,
        WorkspaceRepoInput,
    },
    workspace::{CreateWorkspace, Workspace, WorkspaceKind},
};
use deployment::Deployment;
use executors::{executors::BaseCodingAgent, profile::ExecutorConfig};
use services::services::container::ContainerService;
use utils::response::ApiResponse;
use uuid::Uuid;
use workspace_manager::WorkspaceError;

use crate::{
    DeploymentImpl,
    error::ApiError,
    routes::workspaces::attachments::{
        ImportedIssueAttachment, import_issue_attachments_from_remote,
    },
};

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

    deployment
        .track_if_analytics_allowed(
            "workspace_created",
            serde_json::json!({
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(workspace)))
}

/// Project repos the caller did not supply, as `WorkspaceRepoInput`s on their
/// `default_target_branch`. Dedup is by `repo_id` (caller entries always win
/// and are never duplicated); repos with no default branch are skipped.
fn sibling_repo_inputs(
    caller_repos: &[WorkspaceRepoInput],
    project_repos: &[Repo],
) -> Vec<WorkspaceRepoInput> {
    let supplied: HashSet<Uuid> = caller_repos.iter().map(|r| r.repo_id).collect();
    project_repos
        .iter()
        .filter(|r| !supplied.contains(&r.id))
        .filter_map(|r| {
            r.default_target_branch
                .clone()
                .map(|target_branch| WorkspaceRepoInput {
                    repo_id: r.id,
                    target_branch,
                })
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

fn escape_markdown_label(label: &str) -> String {
    let mut escaped = String::with_capacity(label.len());
    for ch in label.chars() {
        if matches!(ch, '[' | ']' | '\\') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

fn build_workspace_attachment_markdown(
    file: &ImportedIssueAttachment,
    label: &str,
    uses_image_markdown: bool,
) -> String {
    let path = format!(".vibe-attachments/{}", file.file.file_path);
    let normalized_label = if label.trim().is_empty() {
        file.file.original_name.as_str()
    } else {
        label
    };
    let escaped_label = escape_markdown_label(normalized_label);

    if uses_image_markdown {
        format!("![{}]({})", escaped_label, path)
    } else {
        format!("[{}]({})", escaped_label, path)
    }
}

struct ParsedAttachmentMarkdown<'a> {
    attachment_id: Uuid,
    label: &'a str,
    uses_image_markdown: bool,
    end: usize,
}

fn find_unescaped_char(haystack: &str, target: char) -> Option<usize> {
    let mut escaped = false;

    for (index, ch) in haystack.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == target {
            return Some(index);
        }
    }

    None
}

fn parse_attachment_markdown_at(
    prompt: &str,
    start: usize,
) -> Option<ParsedAttachmentMarkdown<'_>> {
    let rest = prompt.get(start..)?;
    let (uses_image_markdown, label_start_offset) = if rest.starts_with("![") {
        (true, 2)
    } else if rest.starts_with('[') {
        (false, 1)
    } else {
        return None;
    };

    let label_rest = rest.get(label_start_offset..)?;
    let label_end_offset = find_unescaped_char(label_rest, ']')?;
    let label = &label_rest[..label_end_offset];

    let after_label = label_rest.get(label_end_offset + 1..)?;
    let attachment_prefix = "(attachment://";
    if !after_label.starts_with(attachment_prefix) {
        return None;
    }

    let attachment_id_start =
        start + label_start_offset + label_end_offset + 1 + attachment_prefix.len();
    let attachment_id_rest = prompt.get(attachment_id_start..)?;
    let attachment_id_end_offset = attachment_id_rest.find(')')?;
    let attachment_id = Uuid::parse_str(&attachment_id_rest[..attachment_id_end_offset]).ok()?;

    Some(ParsedAttachmentMarkdown {
        attachment_id,
        label,
        uses_image_markdown,
        end: attachment_id_start + attachment_id_end_offset + 1,
    })
}

fn rewrite_imported_issue_attachments_markdown(
    prompt: &str,
    imported_attachments: &[ImportedIssueAttachment],
) -> String {
    if imported_attachments.is_empty() {
        return prompt.to_string();
    }

    let imported_by_attachment_id = imported_attachments
        .iter()
        .map(|attachment| (attachment.attachment_id, attachment))
        .collect::<HashMap<_, _>>();
    let mut rewritten = String::with_capacity(prompt.len());
    let mut index = 0;

    while index < prompt.len() {
        if let Some(parsed) = parse_attachment_markdown_at(prompt, index)
            && let Some(attachment) = imported_by_attachment_id.get(&parsed.attachment_id)
        {
            rewritten.push_str(&build_workspace_attachment_markdown(
                attachment,
                parsed.label,
                parsed.uses_image_markdown,
            ));
            index = parsed.end;
            continue;
        }

        let Some(ch) = prompt[index..].chars().next() else {
            break;
        };
        rewritten.push(ch);
        index += ch.len_utf8();
    }

    rewritten
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
        expand_project_repos,
    } = payload;

    let mut workspace_prompt = normalize_prompt(&prompt).ok_or_else(|| {
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

    // Fix 2 (opt-in): siblings the caller did not supply. Read-only; attached after caller repos.
    let sibling_repos: Vec<WorkspaceRepoInput> = if expand_project_repos.unwrap_or(false) {
        match &linked_local_issue {
            Some(issue) => {
                let ids = ProjectRepo::list_repo_ids(pool, issue.project_id).await?;
                let project_repos = Repo::find_by_ids(pool, &ids).await?;
                sibling_repo_inputs(&repos, &project_repos)
            }
            None => Vec::new(),
        }
    } else {
        Vec::new()
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

    if let Some(linked_issue) = &linked_issue
        && let Ok(client) = deployment.remote_client()
    {
        match import_issue_attachments_from_remote(
            &client,
            deployment.file(),
            linked_issue.issue_id,
        )
        .await
        {
            Ok(imported_attachments) if !imported_attachments.is_empty() => {
                let imported_ids = imported_attachments
                    .iter()
                    .map(|imported| imported.file.id)
                    .collect::<Vec<_>>();

                if let Err(e) = managed_workspace.associate_attachments(&imported_ids).await {
                    tracing::warn!("Failed to associate imported files with workspace: {}", e);
                }

                workspace_prompt = rewrite_imported_issue_attachments_markdown(
                    &workspace_prompt,
                    &imported_attachments,
                );

                tracing::info!(
                    "Imported {} files from issue {}",
                    imported_ids.len(),
                    linked_issue.issue_id
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    "Failed to import issue attachments for issue {}: {}",
                    linked_issue.issue_id,
                    e
                );
            }
        }
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

    deployment
        .track_if_analytics_allowed(
            "workspace_created_and_started",
            serde_json::json!({
                "executor": &executor_config.executor,
                "variant": &executor_config.variant,
                "workspace_id": workspace.id.to_string(),
            }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        CreateAndStartWorkspaceResponse {
            workspace,
            execution_process,
        },
    )))
}

/// Build the executor config for the orchestrator: always a headed Claude Code
/// session (its default profile sets `dangerously_skip_permissions`), launched
/// directly AS the orchestrator agent via `--agent` (`agent_id`) rather than as a
/// Task subagent. Requires the `vibe-kanban-indie` plugin installed so the agent
/// name resolves.
fn orchestrator_executor_config() -> ExecutorConfig {
    ExecutorConfig {
        executor: BaseCodingAgent::ClaudeCodeHeaded,
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
            .start_workspace(&existing, orchestrator_executor_config(), prompt)
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
        .start_workspace(&workspace, orchestrator_executor_config(), prompt)
        .await?;

    deployment
        .track_if_analytics_allowed(
            "orchestrator_spawned",
            serde_json::json!({ "workspace_id": workspace.id.to_string() }),
        )
        .await;

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

    deployment
        .track_if_analytics_allowed(
            "orchestrator_closed",
            serde_json::json!({ "workspace_id": existing.id.to_string() }),
        )
        .await;

    Ok(ResponseJson(ApiResponse::success(
        CloseOrchestratorResponse { closed: true },
    )))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use db::models::{file::File, repo::Repo, requests::WorkspaceRepoInput};
    use uuid::Uuid;

    use super::{
        ImportedIssueAttachment, rewrite_imported_issue_attachments_markdown, sibling_repo_inputs,
    };

    fn repo_fixture(id: Uuid, default_target_branch: Option<&str>) -> Repo {
        Repo {
            id,
            path: std::path::PathBuf::from("/tmp/repo"),
            name: "repo".to_string(),
            display_name: "Repo".to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: None,
            default_target_branch: default_target_branch.map(str::to_string),
            default_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn sibling_repo_inputs_includes_sibling_with_default_branch() {
        let sibling_id = Uuid::new_v4();
        let project_repos = vec![repo_fixture(sibling_id, Some("main"))];

        let result = sibling_repo_inputs(&[], &project_repos);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].repo_id, sibling_id);
        assert_eq!(result[0].target_branch, "main");
    }

    #[test]
    fn sibling_repo_inputs_excludes_repo_already_supplied_by_caller() {
        let repo_id = Uuid::new_v4();
        let project_repos = vec![repo_fixture(repo_id, Some("main"))];
        let caller_repos = vec![WorkspaceRepoInput {
            repo_id,
            target_branch: "feature".to_string(),
        }];

        let result = sibling_repo_inputs(&caller_repos, &project_repos);

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_skips_repo_with_no_default_branch() {
        let project_repos = vec![repo_fixture(Uuid::new_v4(), None)];

        let result = sibling_repo_inputs(&[], &project_repos);

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_empty_project_set_yields_empty() {
        let result = sibling_repo_inputs(&[], &[]);

        assert!(result.is_empty());
    }

    #[test]
    fn sibling_repo_inputs_caller_only_repo_not_in_project_set_is_unaffected() {
        let sibling_id = Uuid::new_v4();
        let project_repos = vec![repo_fixture(sibling_id, Some("main"))];
        let caller_only_repo = Uuid::new_v4();
        let caller_repos = vec![WorkspaceRepoInput {
            repo_id: caller_only_repo,
            target_branch: "feature".to_string(),
        }];

        let result = sibling_repo_inputs(&caller_repos, &project_repos);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].repo_id, sibling_id);
        assert_eq!(result[0].target_branch, "main");
    }

    fn imported_file(
        attachment_id: Uuid,
        original_name: &str,
        file_path: &str,
        mime_type: Option<&str>,
    ) -> ImportedIssueAttachment {
        ImportedIssueAttachment {
            attachment_id,
            file: File {
                id: Uuid::new_v4(),
                file_path: file_path.to_string(),
                original_name: original_name.to_string(),
                mime_type: mime_type.map(str::to_string),
                size_bytes: 123,
                hash: "hash".to_string(),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
        }
    }

    #[test]
    fn rewrites_imported_non_image_attachment_links() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("[proposal.pdf](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "[proposal.pdf](.vibe-attachments/abc_proposal.pdf)"
        );
    }

    #[test]
    fn preserves_authored_image_markdown_for_imported_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("![diagram.png](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "diagram.png",
            "xyz_diagram.png",
            Some("image/png"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "![diagram.png](.vibe-attachments/xyz_diagram.png)"
        );
    }

    #[test]
    fn preserves_authored_link_markdown_for_imported_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("[diagram.png](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "diagram.png",
            "xyz_diagram.png",
            Some("image/png"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "[diagram.png](.vibe-attachments/xyz_diagram.png)"
        );
    }

    #[test]
    fn preserves_authored_image_markdown_for_imported_non_images() {
        let attachment_id = Uuid::new_v4();
        let prompt = format!("![proposal.pdf](attachment://{})", attachment_id);
        let imported = vec![imported_file(
            attachment_id,
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "![proposal.pdf](.vibe-attachments/abc_proposal.pdf)"
        );
    }

    #[test]
    fn leaves_unknown_attachment_references_unchanged() {
        let prompt = format!("[proposal.pdf](attachment://{})", Uuid::new_v4());
        let imported = vec![imported_file(
            Uuid::new_v4(),
            "proposal.pdf",
            "abc_proposal.pdf",
            Some("application/pdf"),
        )];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(rewritten, prompt);
    }

    #[test]
    fn rewrites_multiple_attachments_and_leaves_other_links_alone() {
        let image_attachment_id = Uuid::new_v4();
        let file_attachment_id = Uuid::new_v4();
        let prompt = format!(
            "See [doc.pdf](attachment://{}) and ![shot.png](attachment://{}). https://example.com",
            file_attachment_id, image_attachment_id
        );
        let imported = vec![
            imported_file(
                file_attachment_id,
                "doc.pdf",
                "doc_file.pdf",
                Some("application/pdf"),
            ),
            imported_file(
                image_attachment_id,
                "shot.png",
                "shot_file.png",
                Some("image/png"),
            ),
        ];

        let rewritten = rewrite_imported_issue_attachments_markdown(&prompt, &imported);

        assert_eq!(
            rewritten,
            "See [doc.pdf](.vibe-attachments/doc_file.pdf) and ![shot.png](.vibe-attachments/shot_file.png). https://example.com"
        );
    }
}
