use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Local link between a kanban issue (card) and a workspace launched from it.
/// Backed by the `issue_workspaces` table. `workspace_id` is unique, so a
/// workspace belongs to at most one issue (an issue may have many workspaces).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueWorkspace {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub workspace_id: Uuid,
    pub created_at: DateTime<Utc>,
}

/// A linked workspace joined with the columns needed to synthesize the wire
/// `Workspace` shape the frontend's `project_workspaces`/`user_workspaces`
/// fallbacks expect.
#[derive(Debug, Clone)]
pub struct LinkedWorkspaceRow {
    pub workspace_id: Uuid,
    pub issue_id: Uuid,
    pub project_id: Uuid,
    pub name: Option<String>,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub current_pipeline_stage: Option<i64>,
}

impl IssueWorkspace {
    /// Link a workspace to an issue, replacing any existing link for that
    /// workspace (a workspace belongs to at most one issue).
    pub async fn link(
        pool: &SqlitePool,
        issue_id: Uuid,
        workspace_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            IssueWorkspace,
            r#"INSERT INTO issue_workspaces (id, issue_id, workspace_id)
               VALUES ($1, $2, $3)
               ON CONFLICT(workspace_id) DO UPDATE SET issue_id = excluded.issue_id
               RETURNING id as "id!: Uuid", issue_id as "issue_id!: Uuid",
                         workspace_id as "workspace_id!: Uuid",
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            issue_id,
            workspace_id,
        )
        .fetch_one(pool)
        .await
    }

    /// Remove the link for a workspace, if any. Returns rows affected.
    pub async fn unlink_by_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!(
            "DELETE FROM issue_workspaces WHERE workspace_id = $1",
            workspace_id
        )
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    /// Resolve the issue and its project for a workspace, if the workspace is
    /// linked to a kanban issue. Used by the MCP server to derive project/issue
    /// context for a running workspace without any cloud lookup.
    pub async fn find_issue_and_project_by_workspace(
        pool: &SqlitePool,
        workspace_id: Uuid,
    ) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
        let row = sqlx::query!(
            r#"SELECT iw.issue_id as "issue_id!: Uuid", i.project_id as "project_id!: Uuid"
               FROM issue_workspaces iw
               JOIN issues i ON i.id = iw.issue_id
               WHERE iw.workspace_id = $1"#,
            workspace_id
        )
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|r| (r.issue_id, r.project_id)))
    }

    /// Linked workspaces for every issue in a project (for `project_workspaces`).
    pub async fn list_linked_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<LinkedWorkspaceRow>, sqlx::Error> {
        sqlx::query_as!(
            LinkedWorkspaceRow,
            r#"SELECT iw.workspace_id as "workspace_id!: Uuid",
                      iw.issue_id     as "issue_id!: Uuid",
                      i.project_id    as "project_id!: Uuid",
                      w.name          as "name",
                      w.archived      as "archived!: bool",
                      w.created_at    as "created_at!: DateTime<Utc>",
                      w.updated_at    as "updated_at!: DateTime<Utc>",
                      w.current_pipeline_stage as "current_pipeline_stage"
               FROM issue_workspaces iw
               JOIN issues i ON i.id = iw.issue_id
               JOIN workspaces w ON w.id = iw.workspace_id
               WHERE i.project_id = $1
               ORDER BY w.created_at DESC"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }

    /// The most-recently-created workspace linked to an issue, if any. Ordered
    /// by the **workspace's** creation time (not the link row's `created_at`,
    /// which `link`'s `ON CONFLICT DO UPDATE` leaves stale after a relink) —
    /// matches the ordering `list_linked_by_project` already uses.
    pub async fn find_latest_by_issue(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        let row = sqlx::query!(
            r#"SELECT iw.workspace_id as "workspace_id!: Uuid"
               FROM issue_workspaces iw
               JOIN workspaces w ON w.id = iw.workspace_id
               WHERE iw.issue_id = $1
               ORDER BY w.created_at DESC
               LIMIT 1"#,
            issue_id
        )
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|r| r.workspace_id))
    }

    /// All linked workspaces (for `user_workspaces`; local mode has one user).
    pub async fn list_linked_all(
        pool: &SqlitePool,
    ) -> Result<Vec<LinkedWorkspaceRow>, sqlx::Error> {
        sqlx::query_as!(
            LinkedWorkspaceRow,
            r#"SELECT iw.workspace_id as "workspace_id!: Uuid",
                      iw.issue_id     as "issue_id!: Uuid",
                      i.project_id    as "project_id!: Uuid",
                      w.name          as "name",
                      w.archived      as "archived!: bool",
                      w.created_at    as "created_at!: DateTime<Utc>",
                      w.updated_at    as "updated_at!: DateTime<Utc>",
                      w.current_pipeline_stage as "current_pipeline_stage"
               FROM issue_workspaces iw
               JOIN issues i ON i.id = iw.issue_id
               JOIN workspaces w ON w.id = iw.workspace_id
               ORDER BY w.created_at DESC"#
        )
        .fetch_all(pool)
        .await
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    /// In-memory DB with all migrations applied. sqlx enables `PRAGMA
    /// foreign_keys` by default, so `ON DELETE CASCADE` is exercised.
    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn seed_project_status(pool: &SqlitePool) -> (Uuid, Uuid) {
        let project_id = Uuid::new_v4();
        let status_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO projects (id, name, color, sort_order) VALUES (?, 'P', '#fff', 0)",
        )
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO project_statuses (id, project_id, name, color) VALUES (?, ?, 'Todo', '#fff')",
        )
        .bind(status_id)
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();
        (project_id, status_id)
    }

    async fn seed_issue(pool: &SqlitePool, project_id: Uuid, status_id: Uuid, n: i64) -> Uuid {
        let issue_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO issues (id, project_id, issue_number, simple_id, status_id, title)
             VALUES (?, ?, ?, ?, ?, 'T')",
        )
        .bind(issue_id)
        .bind(project_id)
        .bind(n)
        .bind(format!("P-{n}"))
        .bind(status_id)
        .execute(pool)
        .await
        .unwrap();
        issue_id
    }

    async fn seed_workspace(pool: &SqlitePool) -> Uuid {
        let ws_id = Uuid::new_v4();
        sqlx::query("INSERT INTO workspaces (id, branch, name) VALUES (?, 'b', 'ws')")
            .bind(ws_id)
            .execute(pool)
            .await
            .unwrap();
        ws_id
    }

    #[tokio::test]
    async fn link_persists_and_lists_by_project() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws_id = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue_id, ws_id).await.unwrap();

        let rows = IssueWorkspace::list_linked_by_project(&pool, project_id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].workspace_id, ws_id);
        assert_eq!(rows[0].issue_id, issue_id);
        assert_eq!(rows[0].project_id, project_id);
        assert_eq!(rows[0].name.as_deref(), Some("ws"));
        assert_eq!(rows[0].current_pipeline_stage, None);

        // user_workspaces (all links) sees it too.
        assert_eq!(
            IssueWorkspace::list_linked_all(&pool).await.unwrap().len(),
            1
        );
    }

    #[tokio::test]
    async fn current_pipeline_stage_flows_through_linked_workspace_queries() {
        use crate::models::workspace::Workspace;

        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws_id = seed_workspace(&pool).await;
        IssueWorkspace::link(&pool, issue_id, ws_id).await.unwrap();

        Workspace::set_current_pipeline_stage(&pool, ws_id, Some(2))
            .await
            .unwrap();

        let by_project = IssueWorkspace::list_linked_by_project(&pool, project_id)
            .await
            .unwrap();
        assert_eq!(by_project[0].current_pipeline_stage, Some(2));

        let all = IssueWorkspace::list_linked_all(&pool).await.unwrap();
        assert_eq!(all[0].current_pipeline_stage, Some(2));

        // Resetting to NULL (e.g. a fresh coding-agent run) is reflected too.
        Workspace::set_current_pipeline_stage(&pool, ws_id, None)
            .await
            .unwrap();
        let reset = IssueWorkspace::list_linked_by_project(&pool, project_id)
            .await
            .unwrap();
        assert_eq!(reset[0].current_pipeline_stage, None);
    }

    #[tokio::test]
    async fn relink_moves_workspace_to_new_issue() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue1 = seed_issue(&pool, project_id, status_id, 1).await;
        let issue2 = seed_issue(&pool, project_id, status_id, 2).await;
        let ws_id = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue1, ws_id).await.unwrap();
        IssueWorkspace::link(&pool, issue2, ws_id).await.unwrap();

        // UNIQUE(workspace_id) keeps a single row, now pointing at issue2.
        let rows = IssueWorkspace::list_linked_by_project(&pool, project_id)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].issue_id, issue2);
    }

    #[tokio::test]
    async fn unlink_removes_link() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws_id = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue_id, ws_id).await.unwrap();
        let removed = IssueWorkspace::unlink_by_workspace(&pool, ws_id)
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert!(
            IssueWorkspace::list_linked_by_project(&pool, project_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn issue_delete_cascades_link() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws_id = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue_id, ws_id).await.unwrap();
        sqlx::query("DELETE FROM issues WHERE id = ?")
            .bind(issue_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            IssueWorkspace::list_linked_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn find_latest_by_issue_returns_none_without_link() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;

        assert!(
            IssueWorkspace::find_latest_by_issue(&pool, issue_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn find_latest_by_issue_returns_newest_workspace() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws1 = seed_workspace(&pool).await;
        // Ensure a distinct `created_at` ordering for the second workspace.
        sqlx::query("UPDATE workspaces SET created_at = datetime('now', '-1 minute') WHERE id = ?")
            .bind(ws1)
            .execute(&pool)
            .await
            .unwrap();
        let ws2 = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue_id, ws1).await.unwrap();
        IssueWorkspace::link(&pool, issue_id, ws2).await.unwrap();

        let latest = IssueWorkspace::find_latest_by_issue(&pool, issue_id)
            .await
            .unwrap();
        assert_eq!(latest, Some(ws2));
    }

    #[tokio::test]
    async fn workspace_delete_cascades_link() {
        let pool = pool().await;
        let (project_id, status_id) = seed_project_status(&pool).await;
        let issue_id = seed_issue(&pool, project_id, status_id, 1).await;
        let ws_id = seed_workspace(&pool).await;

        IssueWorkspace::link(&pool, issue_id, ws_id).await.unwrap();
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(ws_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            IssueWorkspace::list_linked_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
