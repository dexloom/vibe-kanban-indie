use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct IssueComment {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub message: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct NewIssueComment<'a> {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub parent_id: Option<Uuid>,
    pub message: &'a str,
}

impl IssueComment {
    async fn select(
        pool: &SqlitePool,
        clause: &str,
        id: Uuid,
    ) -> Result<Option<Self>, sqlx::Error> {
        let query = format!(
            r#"SELECT id,
                      issue_id,
                      parent_id,
                      message,
                      created_at,
                      updated_at
               FROM issue_comments {clause}"#
        );
        sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                Option<Uuid>,
                String,
                DateTime<Utc>,
                DateTime<Utc>,
            ),
        >(&query)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map(|row| {
            row.map(
                |(id, issue_id, parent_id, message, created_at, updated_at)| Self {
                    id,
                    issue_id,
                    parent_id,
                    message,
                    created_at,
                    updated_at,
                },
            )
        })
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        Self::select(pool, "WHERE id = ?", id).await
    }

    pub async fn list_by_issue(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            Self,
            r#"SELECT id as "id!: Uuid",
                      issue_id as "issue_id!: Uuid",
                      parent_id as "parent_id: Uuid",
                      message,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM issue_comments WHERE issue_id = $1 ORDER BY created_at ASC"#,
            issue_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(pool: &SqlitePool, new: NewIssueComment<'_>) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            Self,
            r#"INSERT INTO issue_comments (id, issue_id, parent_id, message)
               VALUES ($1, $2, $3, $4)
               RETURNING id as "id!: Uuid",
                         issue_id as "issue_id!: Uuid",
                         parent_id as "parent_id: Uuid",
                         message,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            new.id,
            new.issue_id,
            new.parent_id,
            new.message
        )
        .fetch_one(pool)
        .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        message: Option<&str>,
        parent_id: Option<Option<Uuid>>,
    ) -> Result<Option<Self>, sqlx::Error> {
        let Some(existing) = Self::find_by_id(pool, id).await? else {
            return Ok(None);
        };
        let message = message.unwrap_or(&existing.message);
        let parent_id = parent_id.unwrap_or(existing.parent_id);
        sqlx::query_as!(
            Self,
            r#"UPDATE issue_comments SET message = $2, parent_id = $3,
                    updated_at = datetime('now', 'subsec') WHERE id = $1
               RETURNING id as "id!: Uuid", issue_id as "issue_id!: Uuid",
                         parent_id as "parent_id: Uuid",
                         message, created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            message,
            parent_id
        )
        .fetch_optional(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        Ok(sqlx::query!("DELETE FROM issue_comments WHERE id = $1", id)
            .execute(pool)
            .await?
            .rows_affected())
    }
}
