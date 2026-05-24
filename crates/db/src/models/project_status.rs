use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Kanban column. Mirrors the wire `ProjectStatus` shape (served at
/// /v1/fallback/project_statuses).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStatus {
    pub id: Uuid,
    pub project_id: Uuid,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub hidden: bool,
    pub created_at: DateTime<Utc>,
}

impl ProjectStatus {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            ProjectStatus,
            r#"SELECT id as "id!: Uuid",
                      project_id as "project_id!: Uuid",
                      name,
                      color,
                      sort_order,
                      hidden as "hidden!: bool",
                      created_at as "created_at!: DateTime<Utc>"
               FROM project_statuses
               WHERE project_id = $1
               ORDER BY sort_order ASC"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn count_by_project(pool: &SqlitePool, project_id: Uuid) -> Result<i64, sqlx::Error> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!: i64" FROM project_statuses WHERE project_id = $1"#,
            project_id
        )
        .fetch_one(pool)
        .await?;
        Ok(row.count)
    }

    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        project_id: Uuid,
        name: &str,
        color: &str,
        sort_order: i64,
        hidden: bool,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            ProjectStatus,
            r#"INSERT INTO project_statuses (id, project_id, name, color, sort_order, hidden)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         name,
                         color,
                         sort_order,
                         hidden as "hidden!: bool",
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            project_id,
            name,
            color,
            sort_order,
            hidden,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        name: Option<&str>,
        color: Option<&str>,
        sort_order: Option<i64>,
        hidden: Option<bool>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            ProjectStatus,
            r#"UPDATE project_statuses
               SET name = COALESCE($2, name),
                   color = COALESCE($3, color),
                   sort_order = COALESCE($4, sort_order),
                   hidden = COALESCE($5, hidden)
               WHERE id = $1
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         name,
                         color,
                         sort_order,
                         hidden as "hidden!: bool",
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            name,
            color,
            sort_order,
            hidden,
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM project_statuses WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}
