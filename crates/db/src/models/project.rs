use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Executor, FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// Project-key derivation, single source of truth. Caller passes the project
/// `name`; this strips non-alphanumeric chars, uppercases the first four
/// surviving chars, and falls back to `"PRJ"` when nothing is left.
pub fn derive_key(name: &str) -> String {
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

/// Inputs for `Project::create`. Bundling the eight fields into a struct keeps
/// the call site readable and keeps `too_many_arguments` from firing when a
/// future field is added.
#[derive(Debug, Clone)]
pub struct NewProject<'a> {
    pub id: Uuid,
    pub name: &'a str,
    pub key: Option<&'a str>,
    pub color: &'a str,
    pub sort_order: i64,
    pub default_agent_working_dir: Option<&'a str>,
    pub parent_id: Option<Uuid>,
}

/// Editable presentation fields for `Project::update_fields`. Bundling the
/// seven fields keeps call sites readable.
#[derive(Debug, Clone)]
pub struct ProjectUpdate<'a> {
    pub name: &'a str,
    pub key: Option<&'a str>,
    pub color: &'a str,
    pub sort_order: i64,
    pub default_agent_working_dir: Option<&'a str>,
    pub parent_id: Option<Uuid>,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    /// Per-project issue prefix (e.g. "ACME" -> "ACME-5"). Defaults from name.
    pub key: Option<String>,
    pub color: String,
    pub sort_order: i64,
    pub parent_id: Option<Uuid>,
    pub default_agent_working_dir: Option<String>,
    pub remote_project_id: Option<Uuid>,
    /// ADR-016: per-project / per-board orchestrator prompt. Empty string =
    /// "no prompt at this scope"; resolution walks the parent chain and
    /// composes every non-empty value into a labeled stack (board-first /
    /// project-last). UPGRADE-SAFE: the migration sets DEFAULT '' so
    /// existing rows are valid without rewrite.
    pub orchestrator_prompt: String,
    #[ts(type = "Date")]
    pub created_at: DateTime<Utc>,
    #[ts(type = "Date")]
    pub updated_at: DateTime<Utc>,
}

impl Project {
    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"SELECT id as "id!: Uuid",
                      name,
                      key,
                      color,
                      sort_order,
                      parent_id as "parent_id: Uuid",
                      default_agent_working_dir,
                      remote_project_id as "remote_project_id: Uuid",
                      orchestrator_prompt,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM projects
               ORDER BY sort_order ASC, created_at DESC"#
        )
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"SELECT id as "id!: Uuid",
                      name,
                      key,
                      color,
                      sort_order,
                      parent_id as "parent_id: Uuid",
                      default_agent_working_dir,
                      remote_project_id as "remote_project_id: Uuid",
                      orchestrator_prompt,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM projects
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn find_by_name(pool: &SqlitePool, name: &str) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"SELECT id as "id!: Uuid",
                      name,
                      key,
                      color,
                      sort_order,
                      parent_id as "parent_id: Uuid",
                      default_agent_working_dir,
                      remote_project_id as "remote_project_id: Uuid",
                      orchestrator_prompt,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM projects
               WHERE name = $1
               LIMIT 1"#,
            name
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn create(pool: &SqlitePool, project: NewProject<'_>) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"INSERT INTO projects (id, name, key, color, sort_order, default_agent_working_dir, parent_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id as "id!: Uuid",
                         name,
                         key,
                         color,
                         sort_order,
                         parent_id as "parent_id: Uuid",
                         default_agent_working_dir,
                         remote_project_id as "remote_project_id: Uuid",
                         orchestrator_prompt,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            project.id,
            project.name,
            project.key,
            project.color,
            project.sort_order,
            project.default_agent_working_dir,
            project.parent_id,
        )
        .fetch_one(pool)
        .await
    }

    /// Update the editable presentation fields of a project.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_fields(
        pool: &SqlitePool,
        id: Uuid,
        changes: ProjectUpdate<'_>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"UPDATE projects
               SET name = $2,
                   key = $3,
                   color = $4,
                   sort_order = $5,
                   default_agent_working_dir = $6,
                   parent_id = $7,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $1
               RETURNING id as "id!: Uuid",
                         name,
                         key,
                         color,
                         sort_order,
                         parent_id as "parent_id: Uuid",
                         default_agent_working_dir,
                         remote_project_id as "remote_project_id: Uuid",
                         orchestrator_prompt,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            changes.name,
            changes.key,
            changes.color,
            changes.sort_order,
            changes.default_agent_working_dir,
            changes.parent_id,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn count_children<'e, E>(executor: E, parent_id: Uuid) -> Result<i64, sqlx::Error>
    where
        E: Executor<'e, Database = sqlx::Sqlite>,
    {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects WHERE parent_id = ?")
            .bind(parent_id)
            .fetch_one(executor)
            .await
    }

    pub async fn find_parent_chain_keys(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<Vec<String>, sqlx::Error> {
        let mut keys = Vec::new();
        let mut current_id = Some(id);
        let mut visited = std::collections::HashSet::new();

        while let Some(project_id) = current_id {
            if !visited.insert(project_id) {
                return Err(sqlx::Error::Protocol(
                    "cycle in project parent chain".to_string(),
                ));
            }

            let (key, parent_id, name) =
                sqlx::query_as::<_, (Option<String>, Option<Uuid>, String)>(
                    "SELECT key, parent_id, name FROM projects WHERE id = ?",
                )
                .bind(project_id)
                .fetch_one(pool)
                .await?;
            // B-2: `key` is nullable in the schema; for legacy / hand-edited
            // rows fall back to deriving from the name so the chain stays
            // single-segment rather than crashing the decode.
            let segment = key.unwrap_or_else(|| derive_key(&name));
            keys.push(segment);
            current_id = parent_id;
        }

        keys.reverse();
        Ok(keys)
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM projects WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }

    pub async fn set_remote_project_id(
        pool: &SqlitePool,
        id: Uuid,
        remote_project_id: Option<Uuid>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"UPDATE projects
               SET remote_project_id = $2
               WHERE id = $1"#,
            id,
            remote_project_id
        )
        .execute(pool)
        .await?;

        Ok(())
    }

    /// ADR-016: replace the project's `orchestrator_prompt` (PUT semantics —
    /// no deep-merge, the value IS the new prompt). Empty string clears it.
    /// Dedicated path (not merged into `update_fields`) so the prompt editor
    /// doesn't have to know the rest of the project's presentation fields.
    pub async fn update_orchestrator_prompt(
        pool: &SqlitePool,
        id: Uuid,
        prompt: &str,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            Project,
            r#"UPDATE projects
               SET orchestrator_prompt = $2,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $1
               RETURNING id as "id!: Uuid",
                         name,
                         key,
                         color,
                         sort_order,
                         parent_id as "parent_id: Uuid",
                         default_agent_working_dir,
                         remote_project_id as "remote_project_id: Uuid",
                         orchestrator_prompt,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            prompt,
        )
        .fetch_one(pool)
        .await
    }

    /// ADR-016 (stack amendment): walk the parent chain `self → root`
    /// collecting EVERY non-empty (trimmed) `orchestrator_prompt` as a
    /// labeled stack — most-specific (the queried row, board-level) first,
    /// broadest (root, project-level) last. The returned `String` is the
    /// rendered stack: a fixed mandatory preamble (telling the
    /// orchestrator LLM how to treat the stack) followed by `[Board: …]`
    /// / `[Project: …]` sections. The returned `Option<Uuid>` is the id of
    /// the MOST-SPECIFIC prompt's row (the top-of-stack); the wire
    /// `source` enum derives from it exactly as before (`Self_` if it
    /// equals the queried id, `Ancestor` if a parent supplied it, `Default`
    /// when empty).
    ///
    /// Non-root rows (parent_id non-null) label as `Board`; the root row
    /// (parent_id null) labels as `Project`. Each scope that has a prompt
    /// contributes its own labeled section — absent scopes are omitted.
    /// Resolving a board with both prompts set yields two sections;
    /// resolving the root project yields just `[Project: …]`.
    ///
    /// All-empty / missing-row / cycle / hop-overflow ⇒ `("", None)` —
    /// same abort semantics as the single-prompt resolver, so corrupt
    /// chains never produce a partial stack. Cap 16 hops (mirrors
    /// `derive_key_chain`); cycle-safe via a `HashSet`.
    ///
    /// Why `(String, Option<Uuid>)` and not a helper struct: the only
    /// caller is the route handler, which immediately maps it to a wire
    /// response. The stack TEXT is the payload the orchestrator consumes
    /// (via the MCP tool) — embedding the preamble + labels in the string
    /// keeps the external plugin zero-change (it reads only
    /// `orchestrator_prompt`).
    pub async fn resolve_orchestrator_prompt(
        pool: &SqlitePool,
        id: Uuid,
    ) -> Result<(String, Option<Uuid>), sqlx::Error> {
        const MAX_HOPS: usize = 16;
        let mut current = Some(id);
        let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
        let mut hops = 0usize;
        // Walk-order collection of non-empty prompts: (text, supplier_id,
        // is_root). is_root drives the `Board` vs `Project` label.
        let mut stack: Vec<(String, Uuid, bool)> = Vec::new();

        while let Some(project_id) = current {
            if !seen.insert(project_id) {
                // Cycle: abort to empty (don't emit a partial stack from
                // corrupt data — matches the pre-stack semantics).
                return Ok((String::new(), None));
            }
            if hops >= MAX_HOPS {
                return Ok((String::new(), None));
            }
            hops += 1;

            let row: Option<(Option<String>, Option<Uuid>)> =
                sqlx::query_as("SELECT orchestrator_prompt, parent_id FROM projects WHERE id = ?")
                    .bind(project_id)
                    .fetch_optional(pool)
                    .await?;
            let Some((prompt, parent_id)) = row else {
                // Row vanished mid-walk — abort to empty.
                return Ok((String::new(), None));
            };
            let prompt = prompt.unwrap_or_default();
            let is_root = parent_id.is_none();
            let trimmed = prompt.trim();
            if !trimmed.is_empty() {
                // Trimmed for the stack (cleaner LLM input); the editor
                // reads the raw value separately via the GET endpoint, so
                // no fidelity loss for the operator.
                stack.push((trimmed.to_string(), project_id, is_root));
            }
            current = parent_id;
        }

        if stack.is_empty() {
            return Ok((String::new(), None));
        }
        // Top-of-stack = first non-empty in walk order = queried row if it
        // had a prompt, else the nearest ancestor that did. This id drives
        // the wire `source` enum exactly as before.
        let source_project_id = stack[0].1;
        Ok((
            render_orchestrator_prompt_stack(&stack),
            Some(source_project_id),
        ))
    }
}

/// ADR-016 (stack amendment): render the collected non-empty prompts as
/// the payload the orchestrator LLM consumes. The preamble is a fixed
/// mandatory instruction block — it tells the LLM the text is a scoped
/// stack, how to order precedence (specific overrides broad on direct
/// conflict; otherwise additive), and that the project-level section is
/// the baseline. The XML-ish tags delimit the block so the LLM can
/// cleanly separate it from surrounding tick context.
///
/// Section labels: `Board` for non-root rows, `Project` for the root row.
/// Sections are emitted in walk order (most-specific first) and joined by
/// a blank line for readability.
fn render_orchestrator_prompt_stack(stack: &[(String, Uuid, bool)]) -> String {
    const PREAMBLE: &str = "This is a STACK of scoped orchestrator prompts, \
        ordered most-specific first (board-level) to broadest last (project-level). \
        MANDATORY: follow every section. On a direct conflict between sections, \
        the earlier (more-specific) section overrides the later (broader) one. \
        Where there is no conflict, all sections apply additively; the \
        project-level section is the baseline that always holds.";
    let sections: Vec<String> = stack
        .iter()
        .map(|(text, _id, is_root)| {
            let label = if *is_root { "Project" } else { "Board" };
            format!("[{label}: {text}]")
        })
        .collect();
    format!(
        "<orchestrator_prompt_stack>\n{preamble}\n\n{sections}\n</orchestrator_prompt_stack>",
        preamble = PREAMBLE,
        sections = sections.join("\n\n"),
    )
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::{NewProject, Project, SqlitePool};

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[test]
    fn derive_key_is_uppercase_alnum() {
        assert_eq!(super::derive_key("Acme Corp"), "ACME");
        assert_eq!(super::derive_key("a-b-c-d-e"), "ABCD");
        assert_eq!(super::derive_key("!!!"), "PRJ");
    }

    #[tokio::test]
    async fn project_parent_round_trips_and_restricts_parent_deletion() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Root",
                key: Some("ROOT"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            NewProject {
                id: child_id,
                name: "Child",
                key: Some("CHILD"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();

        let projects = Project::find_all(&pool).await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(
            projects
                .iter()
                .find(|project| project.id == root_id)
                .unwrap()
                .parent_id,
            None
        );
        assert_eq!(
            projects
                .iter()
                .find(|project| project.id == child_id)
                .unwrap()
                .parent_id,
            Some(root_id)
        );

        assert!(Project::delete(&pool, root_id).await.is_err());
    }

    /// B-2 regression: `find_parent_chain_keys` must tolerate a NULL `key`
    /// column (legacy / hand-edited rows) and fall back to the derived key
    /// from the project name rather than panicking on decode.
    #[tokio::test]
    async fn find_parent_chain_keys_handles_null_key_columns() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            NewProject {
                id: child_id,
                name: "Acme Sub",
                // Simulate a legacy / hand-edited row with NULL key.
                key: None,
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();

        // Must not panic on decode; key derived from `name` ("Acme Sub" → "ACME").
        let chain = Project::find_parent_chain_keys(&pool, child_id)
            .await
            .unwrap();
        assert_eq!(chain, vec!["ACME".to_string(), "ACME".to_string()]);
    }

    /// ADR-016 A1: a freshly created project exposes `orchestrator_prompt = ""`.
    /// The migration's `DEFAULT ''` guarantees the column is set for both
    /// pre-existing rows (after upgrade) and new rows (the INSERT omits the
    /// column). Without this the tree's `hasPrompt` dot would render
    /// `undefined` and the editor's resolve badge would misreport.
    #[tokio::test]
    async fn new_project_has_empty_orchestrator_prompt() {
        let pool = pool().await;
        let id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();

        let fetched = Project::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(fetched.orchestrator_prompt, "");

        // find_all must also surface the column (the sidebar tree reads it).
        let all = Project::find_all(&pool).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].orchestrator_prompt, "");
    }

    /// ADR-016 A2: `update_orchestrator_prompt` round-trips and clears,
    /// and `update_fields` does NOT touch the prompt column (PUT is a
    /// dedicated path so the editor doesn't have to read every other
    /// field). If `update_fields` silently overwrote the prompt, the
    /// sidebar's "edit name" flow would wipe the prompt.
    #[tokio::test]
    async fn update_orchestrator_prompt_round_trips_and_is_independent_of_update_fields() {
        let pool = pool().await;
        let id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();

        // Set → round-trip.
        let updated = Project::update_orchestrator_prompt(&pool, id, "be terse")
            .await
            .unwrap();
        assert_eq!(updated.orchestrator_prompt, "be terse");
        let fetched = Project::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(fetched.orchestrator_prompt, "be terse");

        // Clear → empty string round-trips.
        let cleared = Project::update_orchestrator_prompt(&pool, id, "")
            .await
            .unwrap();
        assert_eq!(cleared.orchestrator_prompt, "");

        // Set again, then call update_fields WITHOUT touching the prompt.
        Project::update_orchestrator_prompt(&pool, id, "use sparse commits")
            .await
            .unwrap();
        let existing = Project::find_by_id(&pool, id).await.unwrap().unwrap();
        let _after_update_fields = Project::update_fields(
            &pool,
            id,
            super::ProjectUpdate {
                name: &existing.name,
                key: existing.key.as_deref(),
                color: &existing.color,
                sort_order: existing.sort_order,
                default_agent_working_dir: existing.default_agent_working_dir.as_deref(),
                parent_id: existing.parent_id,
            },
        )
        .await
        .unwrap();
        let fetched = Project::find_by_id(&pool, id).await.unwrap().unwrap();
        assert_eq!(
            fetched.orchestrator_prompt, "use sparse commits",
            "update_fields MUST NOT touch the prompt column"
        );
    }

    /// ADR-016 (stack amendment) — the resolver builds a STACK, not
    /// "first non-empty wins": every non-empty scope contributes a
    /// labeled section, board-first / project-last. These cover:
    /// (a) root prompt set, child empty → only `[Project: …]`, source is
    ///     the root (wire `source: "ancestor"`).
    /// (b) root whitespace-only, child empty → both treated as absent →
    ///     empty stack (`""`, `None`) so the badge reads "default".
    /// (c) child prompt set, root empty → only `[Board: …]`, source is
    ///     the child (wire `source: "self"`).
    /// (d) BOTH set → two sections, board first then project; source is
    ///     the child (most-specific wins the provenance id).
    #[tokio::test]
    async fn resolve_orchestrator_prompt_builds_stack_from_chain() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            NewProject {
                id: child_id,
                name: "Sub",
                key: Some("SUB"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();

        // (a) Root prompt set, child prompt empty → project-only stack,
        // source is the root.
        Project::update_orchestrator_prompt(&pool, root_id, "be terse")
            .await
            .unwrap();
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, child_id)
            .await
            .unwrap();
        assert!(
            got.contains("[Project: be terse]"),
            "root-only stack must carry the Project section; got:\n{got}"
        );
        assert!(
            !got.contains("[Board:"),
            "no board prompt set → no Board section; got:\n{got}"
        );
        assert!(got.contains("MANDATORY"));
        assert!(got.contains("<orchestrator_prompt_stack>"));
        assert_eq!(source, Some(root_id));

        // (b) Root prompt whitespace-only → treated as empty → empty stack.
        Project::update_orchestrator_prompt(&pool, root_id, "   \n  ")
            .await
            .unwrap();
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, child_id)
            .await
            .unwrap();
        assert_eq!(got, "");
        assert_eq!(source, None);

        // (c) Child's own prompt set, root still whitespace-only →
        // board-only stack, source is the child.
        Project::update_orchestrator_prompt(&pool, child_id, "child override")
            .await
            .unwrap();
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, child_id)
            .await
            .unwrap();
        assert!(
            got.contains("[Board: child override]"),
            "board-only stack must carry the Board section; got:\n{got}"
        );
        assert!(
            !got.contains("[Project:"),
            "no root prompt set → no Project section; got:\n{got}"
        );
        assert_eq!(source, Some(child_id));

        // (d) BOTH set → two sections, board first then project; source
        // is the child (most-specific = top-of-stack).
        Project::update_orchestrator_prompt(&pool, root_id, "root baseline")
            .await
            .unwrap();
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, child_id)
            .await
            .unwrap();
        let board_idx = got.find("[Board: child override]").expect("board section");
        let project_idx = got
            .find("[Project: root baseline]")
            .expect("project section");
        assert!(
            board_idx < project_idx,
            "board section MUST come before project section; got:\n{got}"
        );
        assert_eq!(source, Some(child_id));

        // (e) Standalone root resolved DIRECTLY → single Project section,
        // no Board section, source is the root itself.
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, root_id)
            .await
            .unwrap();
        assert!(
            got.contains("[Project: root baseline]"),
            "direct root resolve must carry the Project section; got:\n{got}"
        );
        assert!(
            !got.contains("[Board:"),
            "root is not a board → no Board section; got:\n{got}"
        );
        assert_eq!(source, Some(root_id));
    }

    /// ADR-016 stack amendment — 3+ deep nesting: every non-root level is a
    /// Board section, rendered most-specific (deepest) first up to the root's
    /// Project section. Locks the walk order so an LLM can trust the ordering
    /// even with repeated [Board:] labels.
    #[tokio::test]
    async fn resolve_orchestrator_prompt_stacks_all_levels_deepest_first() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();
        let grandchild_id = Uuid::new_v4();

        for (id, parent, prompt) in [
            (root_id, None, "root baseline"),
            (child_id, Some(root_id), "child board"),
            (grandchild_id, Some(child_id), "grandchild board"),
        ] {
            Project::create(
                &pool,
                NewProject {
                    id,
                    name: &id.to_string(),
                    key: None,
                    color: "#6366f1",
                    sort_order: 0,
                    default_agent_working_dir: None,
                    parent_id: parent,
                },
            )
            .await
            .unwrap();
            Project::update_orchestrator_prompt(&pool, id, prompt)
                .await
                .unwrap();
        }

        let (got, source) = Project::resolve_orchestrator_prompt(&pool, grandchild_id)
            .await
            .unwrap();

        let gc = got.find("[Board: grandchild board]").expect("grandchild");
        let c = got.find("[Board: child board]").expect("child");
        let r = got.find("[Project: root baseline]").expect("root");
        assert!(
            gc < c && c < r,
            "deepest board first, then parent board, root Project last; got:\n{got}"
        );
        assert_eq!(source, Some(grandchild_id));
    }

    /// ADR-016 A3 — all-empty chain: returns `("", None)` (wire maps to
    /// `source: "default"`). The orchestrator plugin treats this as
    /// "no custom instruction — use built-in behavior".
    #[tokio::test]
    async fn resolve_orchestrator_prompt_returns_empty_when_all_empty() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            NewProject {
                id: child_id,
                name: "Sub",
                key: Some("SUB"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();

        // Both empty.
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, child_id)
            .await
            .unwrap();
        assert_eq!(got, "");
        assert_eq!(source, None);

        // Standalone root, empty.
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, root_id)
            .await
            .unwrap();
        assert_eq!(got, "");
        assert_eq!(source, None);

        // Id that doesn't exist — returns empty without hanging.
        let (got, source) = Project::resolve_orchestrator_prompt(&pool, Uuid::new_v4())
            .await
            .unwrap();
        assert_eq!(got, "");
        assert_eq!(source, None);
    }

    /// ADR-016 A3 — cycle guard: a row with `parent_id == self` would
    /// loop forever without the seen-set. We can't introduce a true
    /// self-loop via `create` (F-N3 self-parent guard), so build a
    /// two-row cycle with raw SQL: child→root, then force root→child.
    /// The walk must terminate with `("", None)` instead of hanging.
    #[tokio::test]
    async fn resolve_orchestrator_prompt_terminates_on_cycle() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            NewProject {
                id: root_id,
                name: "Acme",
                key: Some("ACME"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: None,
            },
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            NewProject {
                id: child_id,
                name: "Sub",
                key: Some("SUB"),
                color: "#6366f1",
                sort_order: 0,
                default_agent_working_dir: None,
                parent_id: Some(root_id),
            },
        )
        .await
        .unwrap();

        // Break the chain into a cycle root→child (now both have non-null
        // parents, so the normal `find_parent` flap protects the app
        // layer, but the schema allows it). Raw UPDATE — the resolver
        // alone must catch the cycle.
        sqlx::query("UPDATE projects SET parent_id = ? WHERE id = ?")
            .bind(child_id)
            .bind(root_id)
            .execute(&pool)
            .await
            .unwrap();

        // Bound execution: a 2-second ceiling. If the cycle guard is
        // broken the test will hang and CI will fail with the timeout.
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            Project::resolve_orchestrator_prompt(&pool, root_id),
        )
        .await
        .expect("resolve_orchestrator_prompt must NOT hang on a cycle");
        let (got, source) = result.unwrap();
        assert_eq!(got, "");
        assert_eq!(source, None);
    }
}
