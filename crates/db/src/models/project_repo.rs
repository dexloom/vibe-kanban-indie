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

    /// Repo filesystem paths linked to a project, ordered for stable output.
    /// Used to mirror project→repo links into `projects.toml`.
    pub async fn list_repo_paths(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<String>, sqlx::Error> {
        let paths = sqlx::query_scalar!(
            r#"SELECT r.path as "path!: String"
               FROM project_repos pr
               JOIN repos r ON r.id = pr.repo_id
               WHERE pr.project_id = $1
               ORDER BY r.path ASC"#,
            project_id
        )
        .fetch_all(pool)
        .await?;
        Ok(paths)
    }

    /// Remove a single project↔repo link. No-op if it does not exist.
    pub async fn unlink(
        pool: &SqlitePool,
        project_id: Uuid,
        repo_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query!(
            r#"DELETE FROM project_repos WHERE project_id = $1 AND repo_id = $2"#,
            project_id,
            repo_id
        )
        .execute(pool)
        .await?;
        Ok(())
    }
}
