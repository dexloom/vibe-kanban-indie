//! TOML-based static project/repo configuration.
//!
//! The hosted product stores projects in Postgres behind organisation auth.
//! Locally we let users declare projects and repos in a hand-edited
//! `projects.toml`, reconciled into SQLite at startup. The file is the source
//! of truth for *static* config (repo scripts, branches, project grouping,
//! kanban columns); dynamic state (issues, workspaces, sessions) lives in the
//! database. Reconciliation is additive: it never deletes projects or repos
//! (which would cascade-delete issues/workspaces).

use std::path::PathBuf;

use db::models::{
    local_user::LocalUser,
    project::Project,
    project_repo::ProjectRepo,
    project_status::ProjectStatus,
    repo::{Repo, UpdateRepo},
};
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

const DEFAULT_LOCAL_USER_NAME: &str = "Local";
const DEFAULT_PROJECT_COLOR: &str = "#6366f1";
const DEFAULT_STATUSES: &[&str] = &["Todo", "In Progress", "In Review", "Done"];
const STATUS_PALETTE: &[&str] = &["#94a3b8", "#3b82f6", "#a855f7", "#22c55e", "#f59e0b"];

/// Top-level shape of `projects.toml`.
#[derive(Debug, Default, Deserialize)]
struct ProjectsConfig {
    /// Display name for the predefined local user (issue creator/assignee).
    #[serde(default)]
    local_user_name: Option<String>,
    #[serde(default, rename = "repo")]
    repos: Vec<RepoConfig>,
    #[serde(default, rename = "project")]
    projects: Vec<ProjectConfig>,
}

#[derive(Debug, Deserialize)]
struct RepoConfig {
    path: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    default_target_branch: Option<String>,
    #[serde(default)]
    default_working_dir: Option<String>,
    #[serde(default)]
    copy_files: Vec<String>,
    #[serde(default)]
    parallel_setup_script: bool,
    #[serde(default)]
    setup_script: Option<String>,
    #[serde(default)]
    cleanup_script: Option<String>,
    #[serde(default)]
    archive_script: Option<String>,
    #[serde(default)]
    dev_server_script: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectConfig {
    name: String,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    default_agent_working_dir: Option<String>,
    /// Repo paths grouped under this project (matched against `[[repo]].path`).
    #[serde(default)]
    repos: Vec<String>,
    /// Kanban column names, created in order on first reconcile.
    #[serde(default)]
    statuses: Vec<String>,
}

/// Resolve the config file path: `$VIBE_KANBAN_PROJECTS_CONFIG`, otherwise
/// `~/.vibe-kanban/projects.toml` (falling back to `<asset_dir>/projects.toml`
/// only if the home directory can't be determined).
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("VIBE_KANBAN_PROJECTS_CONFIG") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".vibe-kanban"))
        .unwrap_or_else(utils::assets::asset_dir)
        .join("projects.toml")
}

fn expand_tilde(input: &str) -> String {
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    input.to_string()
}

fn derive_key(name: &str) -> String {
    let key: String = name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .take(4)
        .collect::<String>()
        .to_uppercase();
    if key.is_empty() {
        "PRJ".to_string()
    } else {
        key
    }
}

/// Load `projects.toml` (if present) and reconcile it into the database.
/// Always ensures the predefined local user exists. Errors are returned so the
/// caller can decide whether to treat them as fatal; individual entry failures
/// are logged and skipped.
pub async fn reconcile(pool: &SqlitePool) -> anyhow::Result<()> {
    let path = config_path();
    let config = match std::fs::read_to_string(&path) {
        Ok(raw) => toml::from_str::<ProjectsConfig>(&raw)
            .map_err(|e| anyhow::anyhow!("Failed to parse {}: {e}", path.display()))?,
        Err(_) => {
            tracing::debug!(
                "No projects.toml at {}; skipping config sync",
                path.display()
            );
            ProjectsConfig::default()
        }
    };

    let user_name = config
        .local_user_name
        .as_deref()
        .unwrap_or(DEFAULT_LOCAL_USER_NAME);
    LocalUser::ensure(pool, user_name).await?;

    // Repos: upsert by path, then apply static config.
    for repo_cfg in &config.repos {
        if let Err(e) = reconcile_repo(pool, repo_cfg).await {
            tracing::warn!("Skipping repo '{}': {e}", repo_cfg.path);
        }
    }

    // Projects: upsert by name, link repos, seed statuses.
    for project_cfg in &config.projects {
        if let Err(e) = reconcile_project(pool, project_cfg).await {
            tracing::warn!("Skipping project '{}': {e}", project_cfg.name);
        }
    }

    Ok(())
}

async fn reconcile_repo(pool: &SqlitePool, cfg: &RepoConfig) -> anyhow::Result<()> {
    let expanded = expand_tilde(&cfg.path);
    let path = std::path::Path::new(&expanded);
    let display_name = cfg.display_name.clone().unwrap_or_else(|| {
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| expanded.clone())
    });

    let repo = Repo::find_or_create(pool, path, &display_name).await?;

    let copy_files = if cfg.copy_files.is_empty() {
        Some(None)
    } else {
        Some(Some(cfg.copy_files.join("\n")))
    };

    let update = UpdateRepo {
        display_name: Some(Some(display_name)),
        setup_script: Some(cfg.setup_script.clone()),
        cleanup_script: Some(cfg.cleanup_script.clone()),
        archive_script: Some(cfg.archive_script.clone()),
        copy_files,
        parallel_setup_script: Some(Some(cfg.parallel_setup_script)),
        dev_server_script: Some(cfg.dev_server_script.clone()),
        default_target_branch: Some(cfg.default_target_branch.clone()),
        default_working_dir: Some(cfg.default_working_dir.clone()),
    };
    Repo::update(pool, repo.id, &update)
        .await
        .map_err(|e| anyhow::anyhow!("repo update failed: {e}"))?;
    Ok(())
}

async fn reconcile_project(pool: &SqlitePool, cfg: &ProjectConfig) -> anyhow::Result<()> {
    let key = cfg.key.clone().unwrap_or_else(|| derive_key(&cfg.name));
    let color = cfg
        .color
        .clone()
        .unwrap_or_else(|| DEFAULT_PROJECT_COLOR.to_string());
    let working_dir = cfg.default_agent_working_dir.as_deref();

    let project = match Project::find_by_name(pool, &cfg.name).await? {
        Some(existing) => {
            Project::update_fields(
                pool,
                existing.id,
                &cfg.name,
                Some(&key),
                &color,
                existing.sort_order,
                working_dir,
            )
            .await?
        }
        None => {
            Project::create(
                pool,
                Uuid::new_v4(),
                &cfg.name,
                Some(&key),
                &color,
                0,
                working_dir,
            )
            .await?
        }
    };

    // Link repos by path.
    for repo_path in &cfg.repos {
        let expanded = expand_tilde(repo_path);
        if let Some(repo) = Repo::find_by_path(pool, &expanded).await? {
            ProjectRepo::link(pool, project.id, repo.id).await?;
        } else {
            tracing::warn!(
                "Project '{}' references unknown repo path '{}'",
                cfg.name,
                repo_path
            );
        }
    }

    // Seed kanban columns only if the project has none yet.
    if ProjectStatus::count_by_project(pool, project.id).await? == 0 {
        let names: Vec<String> = if cfg.statuses.is_empty() {
            DEFAULT_STATUSES.iter().map(|s| s.to_string()).collect()
        } else {
            cfg.statuses.clone()
        };
        for (idx, name) in names.iter().enumerate() {
            let color = STATUS_PALETTE[idx % STATUS_PALETTE.len()];
            ProjectStatus::create(
                pool,
                Uuid::new_v4(),
                project.id,
                name,
                color,
                idx as i64,
                false,
            )
            .await?;
        }
    }

    Ok(())
}
