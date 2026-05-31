use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Directed relationship between two kanban issues. `relationship_type` is the
/// snake_case wire value of `api_types::IssueRelationshipType`
/// ("blocking" | "related" | "has_duplicate"); kept as text so the DB layer
/// has no dependency on the api-types enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssueRelationship {
    pub id: Uuid,
    pub issue_id: Uuid,
    pub related_issue_id: Uuid,
    pub relationship_type: String,
    pub created_at: DateTime<Utc>,
}

impl IssueRelationship {
    pub async fn list_by_issue(
        pool: &SqlitePool,
        issue_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            IssueRelationship,
            r#"SELECT id as "id!: Uuid",
                      issue_id as "issue_id!: Uuid",
                      related_issue_id as "related_issue_id!: Uuid",
                      relationship_type,
                      created_at as "created_at!: DateTime<Utc>"
               FROM issue_relationships
               WHERE issue_id = $1
               ORDER BY created_at ASC"#,
            issue_id
        )
        .fetch_all(pool)
        .await
    }

    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        issue_id: Uuid,
        related_issue_id: Uuid,
        relationship_type: &str,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            IssueRelationship,
            r#"INSERT INTO issue_relationships (id, issue_id, related_issue_id, relationship_type)
               VALUES ($1, $2, $3, $4)
               RETURNING id as "id!: Uuid",
                         issue_id as "issue_id!: Uuid",
                         related_issue_id as "related_issue_id!: Uuid",
                         relationship_type,
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            issue_id,
            related_issue_id,
            relationship_type,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM issue_relationships WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}
