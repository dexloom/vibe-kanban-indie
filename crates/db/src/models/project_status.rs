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
    /// Explicit "this card is finished" marker. Replaces the old positional
    /// heuristic (hidden ∪ last visible by sort_order) — reordering columns
    /// no longer changes which one is terminal.
    pub is_terminal: bool,
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
                      is_terminal as "is_terminal!: bool",
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

    #[allow(clippy::too_many_arguments)]
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        project_id: Uuid,
        name: &str,
        color: &str,
        sort_order: i64,
        hidden: bool,
        is_terminal: bool,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query_as!(
            ProjectStatus,
            r#"INSERT INTO project_statuses (id, project_id, name, color, sort_order, hidden, is_terminal)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         name,
                         color,
                         sort_order,
                         hidden as "hidden!: bool",
                         is_terminal as "is_terminal!: bool",
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            project_id,
            name,
            color,
            sort_order,
            hidden,
            is_terminal,
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
        is_terminal: Option<bool>,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as!(
            ProjectStatus,
            r#"UPDATE project_statuses
               SET name = COALESCE($2, name),
                   color = COALESCE($3, color),
                   sort_order = COALESCE($4, sort_order),
                   hidden = COALESCE($5, hidden),
                   is_terminal = COALESCE($6, is_terminal)
               WHERE id = $1
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         name,
                         color,
                         sort_order,
                         hidden as "hidden!: bool",
                         is_terminal as "is_terminal!: bool",
                         created_at as "created_at!: DateTime<Utc>""#,
            id,
            name,
            color,
            sort_order,
            hidden,
            is_terminal,
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

#[cfg(test)]
mod tests {
    use std::borrow::Cow;

    use sqlx::{SqlitePool, migrate::Migrator};
    use uuid::Uuid;

    const TERMINAL_MIGRATION_VERSION: i64 = 20260808000001;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn partial_migrator(from_version: i64, to_version: i64) -> Migrator {
        let full = sqlx::migrate!("./migrations");
        let subset: Vec<_> = full
            .migrations
            .iter()
            .filter(|m| m.version >= from_version && m.version < to_version)
            .cloned()
            .collect();
        Migrator {
            migrations: Cow::Owned(subset),
            ignore_missing: true,
            locking: true,
            no_tx: false,
        }
    }

    async fn insert_legacy_status(
        pool: &SqlitePool,
        project_id: Uuid,
        name: &str,
        sort_order: i64,
        hidden: bool,
    ) {
        sqlx::query(
            "INSERT INTO project_statuses (id, project_id, name, color, sort_order, hidden)
             VALUES (?, ?, ?, '#fff', ?, ?)",
        )
        .bind(Uuid::new_v4())
        .bind(project_id)
        .bind(name)
        .bind(sort_order)
        .bind(hidden)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_project(pool: &SqlitePool, id: Uuid, name: &str) {
        sqlx::query("INSERT INTO projects (id, name, color) VALUES (?, ?, '#fff')")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Existing boards must upgrade with identical terminal-column behavior:
    /// hidden columns ∪ the last visible column by sort_order.
    #[tokio::test]
    async fn backfill_reproduces_positional_heuristic() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        partial_migrator(0, TERMINAL_MIGRATION_VERSION)
            .run(&pool)
            .await
            .unwrap();

        let project_id = Uuid::new_v4();
        insert_project(&pool, project_id, "P").await;
        insert_legacy_status(&pool, project_id, "Todo", 0, false).await;
        insert_legacy_status(&pool, project_id, "In Progress", 1, false).await;
        insert_legacy_status(&pool, project_id, "Done", 2, false).await;
        insert_legacy_status(&pool, project_id, "Cancelled", 3, true).await;

        // A board whose columns are ALL hidden has no "last visible" column.
        let all_hidden_project = Uuid::new_v4();
        insert_project(&pool, all_hidden_project, "H").await;
        insert_legacy_status(&pool, all_hidden_project, "Gone", 0, true).await;

        partial_migrator(TERMINAL_MIGRATION_VERSION, i64::MAX)
            .run(&pool)
            .await
            .unwrap();

        let statuses = super::ProjectStatus::list_by_project(&pool, project_id)
            .await
            .unwrap();
        let terminal: Vec<&str> = statuses
            .iter()
            .filter(|s| s.is_terminal)
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(terminal, vec!["Done", "Cancelled"]);

        let hidden_statuses = super::ProjectStatus::list_by_project(&pool, all_hidden_project)
            .await
            .unwrap();
        assert!(hidden_statuses.iter().all(|s| s.is_terminal));
    }

    /// The terminal marker is data, not position: reordering columns must
    /// not change which ones are terminal.
    #[tokio::test]
    async fn reordering_keeps_terminal_marking() {
        let pool = migrated_pool().await;
        let project_id = Uuid::new_v4();
        insert_project(&pool, project_id, "P").await;

        let todo = super::ProjectStatus::create(
            &pool,
            Uuid::new_v4(),
            project_id,
            "Todo",
            "#fff",
            0,
            false,
            false,
        )
        .await
        .unwrap();
        let done = super::ProjectStatus::create(
            &pool,
            Uuid::new_v4(),
            project_id,
            "Done",
            "#fff",
            1,
            false,
            true,
        )
        .await
        .unwrap();

        super::ProjectStatus::update(&pool, todo.id, None, None, Some(5), None, None)
            .await
            .unwrap();

        let statuses = super::ProjectStatus::list_by_project(&pool, project_id)
            .await
            .unwrap();
        assert_eq!(statuses[0].id, done.id);
        assert!(statuses[0].is_terminal);
        assert!(!statuses[1].is_terminal);
    }
}
