use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Fixed id of the single predefined local user. Issue creator/assignee
/// references point here. Its display name is configurable via projects.toml.
pub const LOCAL_USER_ID: Uuid = Uuid::from_u128(0xA002);

/// Mirrors the wire `User` shape consumed by the frontend (served at
/// /v1/fallback/users) so assignees render without any cloud account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalUser {
    pub id: Uuid,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl LocalUser {
    pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as!(
            LocalUser,
            r#"SELECT id as "id!: Uuid",
                      email,
                      first_name,
                      last_name,
                      username,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM local_users"#
        )
        .fetch_all(pool)
        .await
    }

    /// Ensure the predefined local user exists with the given display name.
    pub async fn ensure(pool: &SqlitePool, name: &str) -> Result<Self, sqlx::Error> {
        let id = LOCAL_USER_ID;
        let email = "local@vibe-kanban.local";
        sqlx::query!(
            r#"INSERT INTO local_users (id, email, first_name, username)
               VALUES ($1, $2, $3, $3)
               ON CONFLICT(id) DO UPDATE
                 SET first_name = excluded.first_name,
                     username = excluded.username,
                     updated_at = datetime('now', 'subsec')"#,
            id,
            email,
            name,
        )
        .execute(pool)
        .await?;

        sqlx::query_as!(
            LocalUser,
            r#"SELECT id as "id!: Uuid",
                      email,
                      first_name,
                      last_name,
                      username,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM local_users
               WHERE id = $1"#,
            id
        )
        .fetch_one(pool)
        .await
    }
}
