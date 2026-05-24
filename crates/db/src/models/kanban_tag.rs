use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Project tag. Mirrors the wire `Tag` shape (served at /v1/fallback/tags).
/// Backed by the `kanban_tags` table (a `tags` table already exists locally).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KanbanTag {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub color: String,
}

impl KanbanTag {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            KanbanTag,
            r#"SELECT id as "id!: Uuid", project_id as "project_id!: Uuid", name, color
               FROM kanban_tags WHERE project_id = $1 ORDER BY name ASC"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        project_id: Uuid,
        name: &str,
        color: &str,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            KanbanTag,
            r#"INSERT INTO kanban_tags (id, project_id, name, color)
               VALUES ($1, $2, $3, $4)
               RETURNING id as "id!: Uuid", project_id as "project_id!: Uuid", name, color"#,
            id,
            project_id,
            name,
            color,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        name: Option<&str>,
        color: Option<&str>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            KanbanTag,
            r#"UPDATE kanban_tags
               SET name = COALESCE($2, name), color = COALESCE($3, color)
               WHERE id = $1
               RETURNING id as "id!: Uuid", project_id as "project_id!: Uuid", name, color"#,
            id,
            name,
            color,
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM kanban_tags WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

/// Issue<->tag link. Served at /v1/fallback/issue_tags.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueTag {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub tag_id: Uuid,
}

impl IssueTag {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            IssueTag,
            r#"SELECT it.id as "id!: Uuid", it.issue_id as "issue_id!: Uuid", it.tag_id as "tag_id!: Uuid"
               FROM issue_tags it
               JOIN issues i ON i.id = it.issue_id
               WHERE i.project_id = $1"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        issue_id: Uuid,
        tag_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            IssueTag,
            r#"INSERT INTO issue_tags (id, issue_id, tag_id)
               VALUES ($1, $2, $3)
               RETURNING id as "id!: Uuid", issue_id as "issue_id!: Uuid", tag_id as "tag_id!: Uuid""#,
            id,
            issue_id,
            tag_id,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM issue_tags WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}

/// Issue assignee. Served at /v1/fallback/issue_assignees.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueAssignee {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub user_id: Uuid,
    pub assigned_at: DateTime<Utc>,
}

impl IssueAssignee {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            IssueAssignee,
            r#"SELECT a.id as "id!: Uuid", a.issue_id as "issue_id!: Uuid",
                      a.user_id as "user_id!: Uuid", a.assigned_at as "assigned_at!: DateTime<Utc>"
               FROM issue_assignees a
               JOIN issues i ON i.id = a.issue_id
               WHERE i.project_id = $1"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        issue_id: Uuid,
        user_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            IssueAssignee,
            r#"INSERT INTO issue_assignees (id, issue_id, user_id)
               VALUES ($1, $2, $3)
               RETURNING id as "id!: Uuid", issue_id as "issue_id!: Uuid",
                         user_id as "user_id!: Uuid", assigned_at as "assigned_at!: DateTime<Utc>""#,
            id,
            issue_id,
            user_id,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM issue_assignees WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}
