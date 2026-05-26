//! TOML-backed project/repo configuration with round-trip CRUD.
//!
//! The hosted product stores projects in Postgres behind organisation auth.
//! Locally, `projects.toml` is the human-editable source of truth for project
//! and repo *config* (name, key, color, repo scripts, branches, grouping,
//! kanban seed columns). The SQLite database keeps `projects`/`repos` rows as an
//! id-anchored *mirror* so every existing read, foreign key, and runtime
//! reference (issues, workspaces, execution state) keeps working unchanged.
//!
//! Lifecycle:
//! - **Startup** ([`reconcile`]): parse `projects.toml` → upsert the DB mirror,
//!   stamp a stable `id` onto each declared block, and export any DB-only
//!   project/repo back into the file. Non-destructive: it never prunes, so a
//!   hand-removed block reappears on next boot — deletion happens via the API.
//! - **Runtime CRUD** ([`create_project`], [`update_project`], [`delete_project`],
//!   [`mirror_repo`], [`forget_repo`]): mutate the DB mirror, then write the
//!   change through to `projects.toml` (format-preserving, atomic). TOML write
//!   failures are logged, never fatal — the DB mirror is what reads serve.

use std::{path::PathBuf, sync::Mutex};

use db::models::{
    local_user::LocalUser,
    project::Project,
    project_repo::ProjectRepo,
    project_status::ProjectStatus,
    repo::{Repo, UpdateRepo},
};
use serde::Deserialize;
use sqlx::SqlitePool;
use toml_edit::{Array, ArrayOfTables, Document, Item, Table, value};
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
    /// Stable id mapped to the DB row. Generated and written back if omitted.
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
    /// Stable id mapped to the DB row. Generated and written back if omitted.
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
    /// Kanban column names, created in order only on first reconcile.
    #[serde(default)]
    statuses: Vec<String>,
}

/// Resolve the config file path: `$VIBE_KANBAN_PROJECTS_CONFIG`, otherwise
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

// ---------------------------------------------------------------------------
// Startup reconcile (projects.toml -> DB), plus id-stamp + DB-only export.
// ---------------------------------------------------------------------------

/// Load `projects.toml` (if present) and reconcile it into the database, then
/// stamp ids and export DB-only entries back into the file. Always ensures the
/// predefined local user exists. Per-entry failures are logged and skipped.
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

    // Repos: upsert by id/path, then apply static config.
    for repo_cfg in &config.repos {
        if let Err(e) = reconcile_repo(pool, repo_cfg).await {
            tracing::warn!("Skipping repo '{}': {e}", repo_cfg.path);
        }
    }

    // Projects: upsert by id/name, link repos, seed statuses.
    for project_cfg in &config.projects {
        if let Err(e) = reconcile_project(pool, project_cfg).await {
            tracing::warn!("Skipping project '{}': {e}", project_cfg.name);
        }
    }

    // Stamp stable ids on declared blocks and export any DB-only entries so the
    // file stays the complete, authoritative record. Never prunes.
    sync_config_file(pool).await;

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

async fn reconcile_project(pool: &SqlitePool, cfg: &ProjectConfig) -> anyhow::Result<()> {
    let key = cfg.key.clone().unwrap_or_else(|| derive_key(&cfg.name));
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
                cfg.id.unwrap_or_else(Uuid::new_v4),
                &cfg.name,
                Some(&key),
                &color,
                0,
                working_dir,
            )
            .await?
        }
    };

    // Link the declared repos, then prune any link no longer declared so the
    // project's `repos` array in projects.toml is authoritative (add *and*
    // remove). Project↔repo links are mutated only here — there is no GUI/API
    // that touches them — so pruning cannot clobber out-of-band links. Unlinking
    // only removes the grouping; it never deletes the repo, its worktrees, or
    // any workspaces.
    let mut declared_repo_ids = Vec::new();
    for repo_path in &cfg.repos {
        let expanded = expand_tilde(repo_path);
        if let Some(repo) = Repo::find_by_path(pool, &expanded).await? {
            ProjectRepo::link(pool, project.id, repo.id).await?;
            declared_repo_ids.push(repo.id);
        } else {
            tracing::warn!(
                "Project '{}' references unknown repo path '{}'",
                cfg.name,
                repo_path
            );
        }
    }
    for existing in ProjectRepo::list_repo_ids(pool, project.id).await? {
        if !declared_repo_ids.contains(&existing) {
            tracing::info!(
                "Unlinking repo {} from project '{}' (no longer in projects.toml)",
                existing,
                cfg.name
            );
            ProjectRepo::unlink(pool, project.id, existing).await?;
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

// ---------------------------------------------------------------------------
// Runtime CRUD — mutate the DB mirror, then write through to projects.toml.
// ---------------------------------------------------------------------------

/// Create a project (DB mirror + TOML block). Derives an issue key from name.
pub async fn create_project(
    pool: &SqlitePool,
    id: Uuid,
    name: &str,
    color: &str,
) -> Result<Project, sqlx::Error> {
    let key = derive_key(name);
    let project = Project::create(pool, id, name, Some(&key), color, 0, None).await?;
    mirror_project(pool, &project).await;
    Ok(project)
}

/// Update a project's presentation fields (DB mirror + TOML block).
#[allow(clippy::too_many_arguments)]
pub async fn update_project(
    pool: &SqlitePool,
    id: Uuid,
    name: &str,
    key: Option<&str>,
    color: &str,
    sort_order: i64,
    default_agent_working_dir: Option<&str>,
) -> Result<Project, sqlx::Error> {
    let project = Project::update_fields(
        pool,
        id,
        name,
        key,
        color,
        sort_order,
        default_agent_working_dir,
    )
    .await?;
    mirror_project(pool, &project).await;
    Ok(project)
}

/// Delete a project (cascades to its statuses/issues/tags/repo links via FK)
/// and remove its block from `projects.toml`.
pub async fn delete_project(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
    let rows = Project::delete(pool, id).await?;
    let id_str = id.to_string();
    edit_document(|doc| {
        if let Some(aot) = doc
            .get_mut("project")
            .and_then(Item::as_array_of_tables_mut)
        {
            remove_table(aot, &id_str, "name", None);
        }
    });
    Ok(rows)
}

/// Write a project's current config (incl. linked repo paths) into the TOML
/// file, creating or replacing its block. Best-effort: errors are logged.
pub async fn mirror_project(pool: &SqlitePool, project: &Project) {
    let repo_paths = ProjectRepo::list_repo_paths(pool, project.id)
        .await
        .unwrap_or_default();
    let id_str = project.id.to_string();
    edit_document(|doc| {
        let aot = array_of_tables(doc, "project");
        let table = upsert_table(aot, &id_str);
        write_project_table(table, project, &repo_paths);
    });
}

/// Write a repo's current config into the TOML file, creating or replacing its
/// block. Best-effort: errors are logged. (No DB access — repos are created via
/// the repo service before this is called.)
pub fn mirror_repo(repo: &Repo) {
    let id_str = repo.id.to_string();
    edit_document(|doc| {
        let aot = array_of_tables(doc, "repo");
        let table = upsert_table(aot, &id_str);
        write_repo_table(table, repo);
    });
}

/// Remove a repo's block from `projects.toml`. `path` is an optional fallback
/// match for legacy blocks written before ids existed.
pub fn forget_repo(id: Uuid, path: Option<&str>) {
    let id_str = id.to_string();
    edit_document(|doc| {
        if let Some(aot) = doc.get_mut("repo").and_then(Item::as_array_of_tables_mut) {
            remove_table(aot, &id_str, "path", path);
        }
    });
}

// ---------------------------------------------------------------------------
// projects.toml document editing (format-preserving, atomic, serialized).
// ---------------------------------------------------------------------------

/// Load the file, apply `edit`, and write it back atomically. Serialized across
/// the process so concurrent mutations don't clobber each other. A missing or
/// unparseable file starts from an empty document. Write failures are logged.
fn edit_document<F: FnOnce(&mut Document)>(edit: F) {
    static FILE_LOCK: Mutex<()> = Mutex::new(());
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let path = config_path();
    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| raw.parse::<Document>().ok())
        .unwrap_or_default();
    edit(&mut doc);
    if let Err(e) = save_document(&path, &doc) {
        tracing::warn!("Failed to write {}: {e}", path.display());
    }
}

fn save_document(path: &std::path::Path, doc: &Document) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "projects.toml".to_string());
    let tmp = path.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, doc.to_string())?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Ensure `[[<key>]]` exists as an array-of-tables and return it.
fn array_of_tables<'a>(doc: &'a mut Document, key: &str) -> &'a mut ArrayOfTables {
    let entry = doc
        .entry(key)
        .or_insert(Item::ArrayOfTables(ArrayOfTables::new()));
    if entry.as_array_of_tables().is_none() {
        *entry = Item::ArrayOfTables(ArrayOfTables::new());
    }
    entry
        .as_array_of_tables_mut()
        .expect("entry was just set to an array of tables")
}

/// Find the table whose `id` matches, or push a fresh one.
fn upsert_table<'a>(aot: &'a mut ArrayOfTables, id: &str) -> &'a mut Table {
    let pos = aot
        .iter()
        .position(|t| t.get("id").and_then(Item::as_str) == Some(id));
    match pos {
        Some(i) => aot.iter_mut().nth(i).expect("position just found"),
        None => {
            aot.push(Table::new());
            aot.iter_mut().last().expect("table just pushed")
        }
    }
}

/// Remove the table matching `id`, or `alt_key == alt_val` for legacy blocks.
fn remove_table(aot: &mut ArrayOfTables, id: &str, alt_key: &str, alt_val: Option<&str>) {
    let pos = aot.iter().position(|t| {
        t.get("id").and_then(Item::as_str) == Some(id)
            || alt_val.is_some_and(|a| t.get(alt_key).and_then(Item::as_str) == Some(a))
    });
    if let Some(i) = pos {
        aot.remove(i);
    }
}

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

fn write_project_table(table: &mut Table, project: &Project, repo_paths: &[String]) {
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
    // `statuses` is a first-seed-only field; leave any existing value untouched.
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

/// Stamp ids onto declared blocks and export any DB-only project/repo into the
/// file. Existing declared blocks keep their hand-written field values (only a
/// missing `id` is added); rows absent from the file are written in full.
async fn sync_config_file(pool: &SqlitePool) {
    let projects = Project::find_all(pool).await.unwrap_or_default();
    let repos = Repo::list_all(pool).await.unwrap_or_default();

    let mut project_repo_paths = Vec::with_capacity(projects.len());
    for p in &projects {
        project_repo_paths.push(
            ProjectRepo::list_repo_paths(pool, p.id)
                .await
                .unwrap_or_default(),
        );
    }

    edit_document(|doc| {
        {
            let aot = array_of_tables(doc, "repo");
            for repo in &repos {
                let id = repo.id.to_string();
                let path = repo.path.to_string_lossy().to_string();
                let pos = aot.iter().position(|t| {
                    t.get("id").and_then(Item::as_str) == Some(id.as_str())
                        || t.get("path")
                            .and_then(Item::as_str)
                            .map(expand_tilde)
                            .as_deref()
                            == Some(path.as_str())
                });
                match pos {
                    Some(i) => {
                        let table = aot.iter_mut().nth(i).expect("position just found");
                        if table.get("id").and_then(Item::as_str) != Some(id.as_str()) {
                            table["id"] = value(id);
                        }
                    }
                    None => {
                        aot.push(Table::new());
                        let table = aot.iter_mut().last().expect("table just pushed");
                        write_repo_table(table, repo);
                    }
                }
            }
        }
        {
            let aot = array_of_tables(doc, "project");
            for (project, paths) in projects.iter().zip(project_repo_paths.iter()) {
                let id = project.id.to_string();
                let pos = aot.iter().position(|t| {
                    t.get("id").and_then(Item::as_str) == Some(id.as_str())
                        || t.get("name").and_then(Item::as_str) == Some(project.name.as_str())
                });
                match pos {
                    Some(i) => {
                        let table = aot.iter_mut().nth(i).expect("position just found");
                        if table.get("id").and_then(Item::as_str) != Some(id.as_str()) {
                            table["id"] = value(id);
                        }
                    }
                    None => {
                        aot.push(Table::new());
                        let table = aot.iter_mut().last().expect("table just pushed");
                        write_project_table(table, project, paths);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `body` with `projects.toml` pointed at a unique temp file. The env
    /// var is process-global, so serialize access across tests.
    fn with_temp_config(body: impl FnOnce(&std::path::Path)) {
        static ENV_GUARD: Mutex<()> = Mutex::new(());
        let _guard = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("projects.toml");
        // SAFETY: ENV_GUARD serializes all readers/writers of this var.
        unsafe { std::env::set_var("VIBE_KANBAN_PROJECTS_CONFIG", &path) };
        body(&path);
        unsafe { std::env::remove_var("VIBE_KANBAN_PROJECTS_CONFIG") };
    }

    #[test]
    fn derive_key_is_uppercase_alnum() {
        assert_eq!(derive_key("Acme Corp"), "ACME");
        assert_eq!(derive_key("a-b-c-d-e"), "ABCD");
        assert_eq!(derive_key("!!!"), "PRJ");
    }

    #[test]
    fn upsert_is_keyed_by_id_and_preserves_comments() {
        with_temp_config(|path| {
            // Hand-written file: a comment plus a legacy block without an id.
            std::fs::write(
                path,
                "# my projects\n\n[[project]]\nname = \"Acme\"\ncolor = \"#ffffff\"\n",
            )
            .unwrap();

            let id = Uuid::from_u128(0x1234);
            let id_str = id.to_string();

            // First upsert appends a distinct, id-keyed block.
            edit_document(|doc| {
                let aot = array_of_tables(doc, "project");
                let table = upsert_table(aot, &id_str);
                table["id"] = value(id_str.clone());
                table["name"] = value("Acme V2");
                table["color"] = value("#000000");
            });

            let raw = std::fs::read_to_string(path).unwrap();
            assert!(raw.contains("# my projects"), "comment must survive writes");
            assert!(raw.contains("Acme V2"));
            let doc = raw.parse::<Document>().unwrap();
            assert_eq!(
                doc["project"].as_array_of_tables().unwrap().len(),
                2,
                "legacy block kept, new id block added"
            );

            // Second upsert with the same id updates in place (no duplicate).
            edit_document(|doc| {
                let aot = array_of_tables(doc, "project");
                let table = upsert_table(aot, &id_str);
                table["color"] = value("#abcabc");
            });
            let raw = std::fs::read_to_string(path).unwrap();
            let doc = raw.parse::<Document>().unwrap();
            assert_eq!(doc["project"].as_array_of_tables().unwrap().len(), 2);
            assert!(raw.contains("#abcabc"));

            // Removal by id drops only the matching block.
            edit_document(|doc| {
                if let Some(aot) = doc
                    .get_mut("project")
                    .and_then(Item::as_array_of_tables_mut)
                {
                    remove_table(aot, &id_str, "name", None);
                }
            });
            let raw = std::fs::read_to_string(path).unwrap();
            assert!(!raw.contains(&id_str), "removed block's id is gone");
            let doc = raw.parse::<Document>().unwrap();
            assert_eq!(doc["project"].as_array_of_tables().unwrap().len(), 1);
            assert!(raw.contains("# my projects"));
        });
    }

    #[test]
    fn write_repo_table_round_trips_fields() {
        with_temp_config(|path| {
            let id = Uuid::from_u128(0xBEEF);
            let id_str = id.to_string();
            edit_document(|doc| {
                let aot = array_of_tables(doc, "repo");
                let table = upsert_table(aot, &id_str);
                table["id"] = value(id_str.clone());
                table["path"] = value("/tmp/acme");
                table["display_name"] = value("Acme");
                set_str_array(table, "copy_files", &[".env".into(), "x.toml".into()]);
                table["parallel_setup_script"] = value(true);
            });

            let raw = std::fs::read_to_string(path).unwrap();
            let doc = raw.parse::<Document>().unwrap();
            let t = &doc["repo"].as_array_of_tables().unwrap().get(0).unwrap();
            assert_eq!(t.get("path").and_then(Item::as_str), Some("/tmp/acme"));
            assert_eq!(
                t.get("parallel_setup_script").and_then(Item::as_bool),
                Some(true)
            );
            let copy = t.get("copy_files").and_then(Item::as_array).unwrap();
            assert_eq!(copy.len(), 2);
        });
    }
}
