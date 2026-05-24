use sqlx::SqlitePool;
use uuid::Uuid;

/// Many-to-many link between a project and the repos it groups.
pub struct ProjectRepo;

impl ProjectRepo {
    /// Idempotently link a repo to a project.
    pub async fn link(
        pool: &SqlitePool,
        project_id: Uuid,
        repo_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let id = Uuid::new_v4();
        sqlx::query!(
            r#"INSERT INTO project_repos (id, project_id, repo_id)
               VALUES ($1, $2, $3)
               ON CONFLICT(project_id, repo_id) DO NOTHING"#,
            id,
            project_id,
            repo_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_repo_ids(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar!(
            r#"SELECT repo_id as "repo_id!: Uuid" FROM project_repos WHERE project_id = $1"#,
            project_id
        )
        .fetch_all(pool)
        .await
    }
}
