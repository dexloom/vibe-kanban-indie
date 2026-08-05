use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

/// Synthetic organisation id used for all local projects. The hosted product
/// scopes projects by organisation; locally there is a single implicit org so
/// the frontend's org-scoped shapes resolve without any cloud account.
pub const LOCAL_ORGANIZATION_ID: Uuid = Uuid::from_u128(0xA001);

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

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        name: &str,
        key: Option<&str>,
        color: &str,
        sort_order: i64,
        default_agent_working_dir: Option<&str>,
        parent_id: Option<Uuid>,
    ) -> Result<Self, sqlx::Error> {
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
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            name,
            key,
            color,
            sort_order,
            default_agent_working_dir,
            parent_id,
        )
        .fetch_one(pool)
        .await
    }

    /// Update the editable presentation fields of a project.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_fields(
        pool: &SqlitePool,
        id: Uuid,
        name: &str,
        key: Option<&str>,
        color: &str,
        sort_order: i64,
        default_agent_working_dir: Option<&str>,
        parent_id: Option<Uuid>,
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
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            name,
            key,
            color,
            sort_order,
            default_agent_working_dir,
            parent_id,
        )
        .fetch_one(pool)
        .await
    }

    pub async fn count_children(pool: &SqlitePool, parent_id: Uuid) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects WHERE parent_id = ?")
            .bind(parent_id)
            .fetch_one(pool)
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

            let (key, parent_id) = sqlx::query_as::<_, (String, Option<Uuid>)>(
                "SELECT key, parent_id FROM projects WHERE id = ?",
            )
            .bind(project_id)
            .fetch_one(pool)
            .await?;
            keys.push(key);
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
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use uuid::Uuid;

    use super::{Project, SqlitePool};

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn project_parent_round_trips_and_restricts_parent_deletion() {
        let pool = pool().await;
        let root_id = Uuid::new_v4();
        let child_id = Uuid::new_v4();

        Project::create(
            &pool,
            root_id,
            "Root",
            Some("ROOT"),
            "#6366f1",
            0,
            None,
            None,
        )
        .await
        .unwrap();
        Project::create(
            &pool,
            child_id,
            "Child",
            Some("CHILD"),
            "#6366f1",
            0,
            None,
            Some(root_id),
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
}
