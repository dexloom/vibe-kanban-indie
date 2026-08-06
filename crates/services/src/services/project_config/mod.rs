//! Static project/repo config export & import (TOML <-> DB).
//!
//! The SQLite database is the source of truth for projects, repos, their links,
//! and kanban columns — they are created and edited through the API. TOML is no
//! longer auto-loaded at startup or written through on every mutation. Instead it
//! is an explicit, portable export/import format for the *static* config:
//! projects, repos, project↔repo links, kanban seed columns, and executor
//! profiles (agents). Issues, workspaces, tags, and other runtime state are never
//! part of it.
//!
//! - [`export_to_string`] / [`export_to_path`]: serialise the current DB config
//!   (plus the cached executor profiles) into a single TOML document.
//! - [`import_from_str`] / [`import_from_path`]: parse a TOML document and
//!   non-destructively upsert it into the DB — match by `id`, then by name/path;
//!   never deletes existing rows or links — then apply any embedded executor
//!   profiles.

use std::path::{Path, PathBuf};

use db::models::{
    project::{self, NewProject, Project, ProjectUpdate},
    project_repo::ProjectRepo,
    project_status::ProjectStatus,
    repo::{Repo, UpdateRepo},
};
use executors::profile::ExecutorConfigs;
use serde::Deserialize;
use sqlx::SqlitePool;
use toml_edit::{Array, ArrayOfTables, Document, Item, Table, value};
use uuid::Uuid;

const DEFAULT_PROJECT_COLOR: &str = "#6366f1";
const DEFAULT_STATUSES: &[&str] = &["Todo", "In Progress", "In Review", "Done"];
const STATUS_PALETTE: &[&str] = &["#94a3b8", "#3b82f6", "#a855f7", "#22c55e", "#f59e0b"];

/// Top-level shape of an exported/imported config document.
#[derive(Debug, Default, Deserialize)]
struct ProjectsConfig {
    /// Executor profiles (agents) as the JSON the profiles API round-trips.
    #[serde(default)]
    profiles_json: Option<String>,
    #[serde(default, rename = "repo")]
    repos: Vec<RepoConfig>,
    #[serde(default, rename = "project")]
    projects: Vec<ProjectConfig>,
}

#[derive(Debug, Deserialize)]
struct RepoConfig {
    /// Stable id mapped to the DB row. Generated if omitted.
    #[serde(default)]
    id: Option<Uuid>,
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
    /// Stable id mapped to the DB row. Generated if omitted.
    #[serde(default)]
    id: Option<Uuid>,
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
    /// Kanban column names, created in order only when the project has none yet.
    #[serde(default)]
    statuses: Vec<String>,
}

/// Default export/import path: `$VIBE_KANBAN_PROJECTS_CONFIG`, otherwise
/// `~/.vibe-kanban/projects.toml` (falling back to `<asset_dir>/projects.toml`
/// only if the home directory can't be determined).
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("VIBE_KANBAN_PROJECTS_CONFIG")
        && !p.is_empty()
    {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .map(|home| home.join(".vibe-kanban"))
        .unwrap_or_else(utils::assets::asset_dir)
        .join("projects.toml")
}

fn expand_tilde(input: &str) -> String {
    if let Some(rest) = input.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest).to_string_lossy().to_string();
    }
    input.to_string()
}

// ---------------------------------------------------------------------------
// Import (TOML -> DB), non-destructive upsert.
// ---------------------------------------------------------------------------

/// Counts of what an import touched.
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct ImportSummary {
    pub projects: usize,
    pub repos: usize,
    pub links: usize,
    pub profiles_applied: bool,
}

/// Read a TOML file and import it (see [`import_from_str`]).
pub async fn import_from_path(pool: &SqlitePool, path: &Path) -> anyhow::Result<ImportSummary> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("Failed to read {}: {e}", path.display()))?;
    import_from_str(pool, &raw).await
}

/// Parse a TOML config document and upsert it into the database. Matches rows by
/// `id`, then by name/path; updates the fields of matched rows and inserts new
/// ones. Never deletes a project, repo, or link that isn't in the document.
/// Embedded executor profiles, if present, are saved as overrides. Per-entry
/// failures are logged and skipped.
pub async fn import_from_str(pool: &SqlitePool, raw: &str) -> anyhow::Result<ImportSummary> {
    let config: ProjectsConfig =
        toml::from_str(raw).map_err(|e| anyhow::anyhow!("Failed to parse config: {e}"))?;
    let mut summary = ImportSummary::default();

    for repo_cfg in &config.repos {
        match import_repo(pool, repo_cfg).await {
            Ok(()) => summary.repos += 1,
            Err(e) => tracing::warn!("Skipping repo '{}': {e}", repo_cfg.path),
        }
    }

    for project_cfg in &config.projects {
        match import_project(pool, project_cfg).await {
            Ok(links) => {
                summary.projects += 1;
                summary.links += links;
            }
            Err(e) => tracing::warn!("Skipping project '{}': {e}", project_cfg.name),
        }
    }

    if let Some(json) = config.profiles_json.as_deref() {
        match serde_json::from_str::<ExecutorConfigs>(json) {
            Ok(profiles) => match profiles.save_overrides() {
                Ok(()) => {
                    ExecutorConfigs::reload();
                    summary.profiles_applied = true;
                }
                Err(e) => tracing::warn!("Failed to save imported executor profiles: {e}"),
            },
            Err(e) => tracing::warn!("Invalid profiles_json in import: {e}"),
        }
    }

    Ok(summary)
}

async fn import_repo(pool: &SqlitePool, cfg: &RepoConfig) -> anyhow::Result<()> {
    let expanded = expand_tilde(&cfg.path);
    let path = std::path::Path::new(&expanded);
    let display_name = cfg.display_name.clone().unwrap_or_else(|| {
        path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| expanded.clone())
    });

    // Honor a declared id when inserting a brand-new repo; an existing repo at
    // this path keeps its id (path is the unique anchor).
    let repo = match cfg.id {
        Some(id) => Repo::find_or_create_with_id(pool, path, &display_name, id).await?,
        None => Repo::find_or_create(pool, path, &display_name).await?,
    };

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

/// Upsert a project and link its declared repos. Returns the number of links
/// established. Links are only added, never pruned (import is non-destructive).
async fn import_project(pool: &SqlitePool, cfg: &ProjectConfig) -> anyhow::Result<usize> {
    let key = cfg
        .key
        .clone()
        .unwrap_or_else(|| project::derive_key(&cfg.name));
    let color = cfg
        .color
        .clone()
        .unwrap_or_else(|| DEFAULT_PROJECT_COLOR.to_string());
    let working_dir = cfg.default_agent_working_dir.as_deref();

    // Resolve the project: prefer the declared id, then name, else create.
    let existing = match cfg.id {
        Some(id) => match Project::find_by_id(pool, id).await? {
            Some(p) => Some(p),
            None => Project::find_by_name(pool, &cfg.name).await?,
        },
        None => Project::find_by_name(pool, &cfg.name).await?,
    };

    let project = match existing {
        Some(existing) => {
            Project::update_fields(
                pool,
                existing.id,
                ProjectUpdate {
                    name: &cfg.name,
                    key: Some(&key),
                    color: &color,
                    sort_order: existing.sort_order,
                    default_agent_working_dir: working_dir,
                    parent_id: existing.parent_id,
                },
            )
            .await?
        }
        None => {
            Project::create(
                pool,
                NewProject {
                    id: cfg.id.unwrap_or_else(Uuid::new_v4),
                    name: &cfg.name,
                    key: Some(&key),
                    color: &color,
                    sort_order: 0,
                    default_agent_working_dir: working_dir,
                    parent_id: None,
                },
            )
            .await?
        }
    };

    // Link the declared repos by path. Existing links are left untouched.
    let mut links = 0;
    for repo_path in &cfg.repos {
        let expanded = expand_tilde(repo_path);
        if let Some(repo) = Repo::find_by_path(pool, &expanded).await? {
            ProjectRepo::link(pool, project.id, repo.id).await?;
            links += 1;
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

    Ok(links)
}

/// Seed default kanban columns for a freshly created project (used by the API
/// when a project is created directly in the DB). No-op if it already has any.
pub async fn seed_default_statuses(pool: &SqlitePool, project_id: Uuid) -> anyhow::Result<()> {
    if ProjectStatus::count_by_project(pool, project_id).await? != 0 {
        return Ok(());
    }
    for (idx, name) in DEFAULT_STATUSES.iter().enumerate() {
        let color = STATUS_PALETTE[idx % STATUS_PALETTE.len()];
        ProjectStatus::create(
            pool,
            Uuid::new_v4(),
            project_id,
            name,
            color,
            idx as i64,
            false,
        )
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Export (DB -> TOML).
// ---------------------------------------------------------------------------

/// Serialise the current static config into a single TOML document: the local
/// user name, every repo, every project (with its linked repo paths and current
/// kanban columns), and the cached executor profiles as `profiles_json`.
pub async fn export_to_string(pool: &SqlitePool) -> anyhow::Result<String> {
    let mut doc = Document::new();

    // Top-level scalar keys MUST be emitted before any array-of-tables, otherwise
    // they would parse as belonging to the last table. Insert them first.

    let profiles = ExecutorConfigs::get_cached();
    match serde_json::to_string(&profiles) {
        Ok(json) => doc["profiles_json"] = value(json),
        Err(e) => tracing::warn!("Failed to serialise executor profiles for export: {e}"),
    }

    let repos = Repo::list_all(pool).await?;
    if !repos.is_empty() {
        let mut tables = ArrayOfTables::new();
        for repo in &repos {
            let mut table = Table::new();
            write_repo_table(&mut table, repo);
            tables.push(table);
        }
        doc.insert("repo", Item::ArrayOfTables(tables));
    }

    let projects = Project::find_all(pool).await?;
    if !projects.is_empty() {
        let mut tables = ArrayOfTables::new();
        for project in &projects {
            let repo_paths = ProjectRepo::list_repo_paths(pool, project.id)
                .await
                .unwrap_or_default();
            let statuses: Vec<String> = ProjectStatus::list_by_project(pool, project.id)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|s| s.name)
                .collect();
            let mut table = Table::new();
            write_project_table(&mut table, project, &repo_paths, &statuses);
            tables.push(table);
        }
        doc.insert("project", Item::ArrayOfTables(tables));
    }

    Ok(doc.to_string())
}

/// Export the static config and write it atomically to `path`.
pub async fn export_to_path(pool: &SqlitePool, path: &Path) -> anyhow::Result<()> {
    let content = export_to_string(pool).await?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "projects.toml".to_string());
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, &content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// TOML table serialisation helpers.
// ---------------------------------------------------------------------------

fn set_opt_str(table: &mut Table, key: &str, val: Option<&str>) {
    match val {
        Some(v) => table[key] = value(v),
        None => {
            table.remove(key);
        }
    }
}

fn set_str_array(table: &mut Table, key: &str, items: &[String]) {
    let mut arr = Array::new();
    for item in items {
        arr.push(item.as_str());
    }
    table[key] = value(arr);
}

fn write_project_table(
    table: &mut Table,
    project: &Project,
    repo_paths: &[String],
    statuses: &[String],
) {
    table["id"] = value(project.id.to_string());
    table["name"] = value(project.name.as_str());
    set_opt_str(table, "key", project.key.as_deref());
    table["color"] = value(project.color.as_str());
    set_opt_str(
        table,
        "default_agent_working_dir",
        project.default_agent_working_dir.as_deref(),
    );
    set_str_array(table, "repos", repo_paths);
    set_str_array(table, "statuses", statuses);
}

fn write_repo_table(table: &mut Table, repo: &Repo) {
    table["id"] = value(repo.id.to_string());
    table["path"] = value(repo.path.to_string_lossy().as_ref());
    table["display_name"] = value(repo.display_name.as_str());
    set_opt_str(
        table,
        "default_target_branch",
        repo.default_target_branch.as_deref(),
    );
    set_opt_str(
        table,
        "default_working_dir",
        repo.default_working_dir.as_deref(),
    );
    let copy_files: Vec<String> = repo
        .copy_files
        .as_deref()
        .map(|s| s.lines().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    set_str_array(table, "copy_files", &copy_files);
    table["parallel_setup_script"] = value(repo.parallel_setup_script);
    set_opt_str(table, "setup_script", repo.setup_script.as_deref());
    set_opt_str(table, "cleanup_script", repo.cleanup_script.as_deref());
    set_opt_str(table, "archive_script", repo.archive_script.as_deref());
    set_opt_str(
        table,
        "dev_server_script",
        repo.dev_server_script.as_deref(),
    );
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
        pool
    }

    /// Exported config must be valid TOML: top-level scalar keys
    /// (`profiles_json`) have to precede the `[[repo]]`/`[[project]]` arrays, or
    /// they would parse into the last table.
    #[tokio::test]
    async fn export_is_valid_toml_with_scalars_first() {
        let pool = pool().await;
        let toml = export_to_string(&pool).await.unwrap();
        // Round-trips back through the import shape without error.
        let _cfg: ProjectsConfig = toml::from_str(&toml).unwrap();
        assert!(toml.contains("profiles_json"));
    }

    /// Seed a project + repo + link + custom statuses in the DB, export, then
    /// import into a fresh DB and assert everything is restored.
    #[tokio::test]
    async fn export_import_round_trip() {
        let src = pool().await;

        // A repo on disk-agnostic path + a project that links it with custom cols.
        let repo = Repo::find_or_create(&src, std::path::Path::new("/tmp/acme"), "Acme")
            .await
            .unwrap();
        let project = Project::create(
            &src,
            NewProject {
                id: Uuid::new_v4(),
                name: "Acme",
                key: Some("ACME"),
                color: "#123456",
                sort_order: 0,
                default_agent_working_dir: Some("/src"),
                parent_id: None,
            },
        )
        .await
        .unwrap();
        ProjectRepo::link(&src, project.id, repo.id).await.unwrap();
        for (i, name) in ["Backlog", "Doing", "Done"].iter().enumerate() {
            ProjectStatus::create(
                &src,
                Uuid::new_v4(),
                project.id,
                name,
                "#fff",
                i as i64,
                false,
            )
            .await
            .unwrap();
        }

        let exported = export_to_string(&src).await.unwrap();

        // Import into a clean DB.
        let dst = pool().await;
        let summary = import_from_str(&dst, &exported).await.unwrap();
        assert_eq!(summary.projects, 1);
        assert_eq!(summary.repos, 1);
        assert_eq!(summary.links, 1);

        let projects = Project::find_all(&dst).await.unwrap();
        assert_eq!(projects.len(), 1);
        let p = &projects[0];
        assert_eq!(p.id, project.id);
        assert_eq!(p.name, "Acme");
        assert_eq!(p.key.as_deref(), Some("ACME"));
        assert_eq!(p.color, "#123456");
        assert_eq!(p.default_agent_working_dir.as_deref(), Some("/src"));

        let linked = ProjectRepo::list_repo_paths(&dst, p.id).await.unwrap();
        assert_eq!(linked, vec!["/tmp/acme".to_string()]);

        let statuses: Vec<String> = ProjectStatus::list_by_project(&dst, p.id)
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(statuses, vec!["Backlog", "Doing", "Done"]);
    }

    /// Import matches existing rows by id and updates them (non-destructive).
    #[tokio::test]
    async fn import_upserts_existing_by_id() {
        let pool = pool().await;
        let id = Uuid::new_v4();
        Project::create(
            &pool,
            NewProject {
                id,
                name: "Old",
                key: Some("OLD"),
                color: "#000000",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();

        let toml = format!(
            "[[project]]\nid = \"{id}\"\nname = \"New\"\nkey = \"NEW\"\ncolor = \"#ffffff\"\n"
        );
        let summary = import_from_str(&pool, &toml).await.unwrap();
        assert_eq!(summary.projects, 1);

        let projects = Project::find_all(&pool).await.unwrap();
        assert_eq!(projects.len(), 1, "matched existing row, no duplicate");
        assert_eq!(projects[0].name, "New");
        assert_eq!(projects[0].color, "#ffffff");
    }
}
