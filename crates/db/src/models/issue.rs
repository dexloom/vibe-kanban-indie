use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

/// Kanban card. Mirrors the wire `Issue` shape consumed by the frontend
/// (served at /v1/fallback/issues, mutated at /v1/issues).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub id: Uuid,
    pub project_id: Uuid,
    pub issue_number: i64,
    pub simple_id: String,
    pub status_id: Uuid,
    pub title: String,
    pub description: Option<String>,
    /// Serialised IssuePriority value ("urgent" | "high" | "medium" | "low").
    pub priority: Option<String>,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
    pub parent_issue_sort_order: Option<f64>,
    pub extension_metadata: Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Row representation: `extension_metadata` is stored as a JSON TEXT column.
struct IssueRow {
    id: Uuid,
    project_id: Uuid,
    issue_number: i64,
    simple_id: String,
    status_id: Uuid,
    title: String,
    description: Option<String>,
    priority: Option<String>,
    start_date: Option<DateTime<Utc>>,
    target_date: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    sort_order: f64,
    parent_issue_id: Option<Uuid>,
    parent_issue_sort_order: Option<f64>,
    extension_metadata: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<IssueRow> for Issue {
    fn from(r: IssueRow) -> Self {
        Issue {
            id: r.id,
            project_id: r.project_id,
            issue_number: r.issue_number,
            simple_id: r.simple_id,
            status_id: r.status_id,
            title: r.title,
            description: r.description,
            priority: r.priority,
            start_date: r.start_date,
            target_date: r.target_date,
            completed_at: r.completed_at,
            sort_order: r.sort_order,
            parent_issue_id: r.parent_issue_id,
            parent_issue_sort_order: r.parent_issue_sort_order,
            extension_metadata: serde_json::from_str(&r.extension_metadata)
                .unwrap_or(Value::Object(Default::default())),
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// Full field set for creating an issue. `id` may be client-generated.
pub struct NewIssue<'a> {
    pub id: Uuid,
    pub project_id: Uuid,
    pub status_id: Uuid,
    pub title: &'a str,
    pub description: Option<&'a str>,
    pub priority: Option<&'a str>,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
    pub parent_issue_sort_order: Option<f64>,
    pub extension_metadata: &'a str,
    /// Project issue prefix used to build `simple_id`.
    pub key: &'a str,
}

/// Full new state for an update (the route merges partial requests first).
pub struct IssueUpdate<'a> {
    pub status_id: Uuid,
    pub title: &'a str,
    pub description: Option<&'a str>,
    pub priority: Option<&'a str>,
    pub start_date: Option<DateTime<Utc>>,
    pub target_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub sort_order: f64,
    pub parent_issue_id: Option<Uuid>,
    pub parent_issue_sort_order: Option<f64>,
    pub extension_metadata: &'a str,
}

impl Issue {
    pub async fn list_by_project(
        pool: &SqlitePool,
        project_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        let rows = sqlx::query_as!(
            IssueRow,
            r#"SELECT id as "id!: Uuid",
                      project_id as "project_id!: Uuid",
                      issue_number,
                      simple_id,
                      status_id as "status_id!: Uuid",
                      title,
                      description,
                      priority,
                      start_date as "start_date: DateTime<Utc>",
                      target_date as "target_date: DateTime<Utc>",
                      completed_at as "completed_at: DateTime<Utc>",
                      sort_order as "sort_order!: f64",
                      parent_issue_id as "parent_issue_id: Uuid",
                      parent_issue_sort_order as "parent_issue_sort_order: f64",
                      extension_metadata,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM issues
               WHERE project_id = $1
               ORDER BY sort_order ASC"#,
            project_id
        )
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(Issue::from).collect())
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query_as!(
            IssueRow,
            r#"SELECT id as "id!: Uuid",
                      project_id as "project_id!: Uuid",
                      issue_number,
                      simple_id,
                      status_id as "status_id!: Uuid",
                      title,
                      description,
                      priority,
                      start_date as "start_date: DateTime<Utc>",
                      target_date as "target_date: DateTime<Utc>",
                      completed_at as "completed_at: DateTime<Utc>",
                      sort_order as "sort_order!: f64",
                      parent_issue_id as "parent_issue_id: Uuid",
                      parent_issue_sort_order as "parent_issue_sort_order: f64",
                      extension_metadata,
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>"
               FROM issues
               WHERE id = $1"#,
            id
        )
        .fetch_optional(pool)
        .await?;
        Ok(row.map(Issue::from))
    }

    pub async fn create(pool: &SqlitePool, new: NewIssue<'_>) -> Result<Self, sqlx::Error> {
        let next = sqlx::query!(
            r#"SELECT COALESCE(MAX(issue_number), 0) + 1 as "n!: i64"
               FROM issues WHERE project_id = $1"#,
            new.project_id
        )
        .fetch_one(pool)
        .await?;
        let issue_number = next.n;
        let simple_id = format!("{}-{}", new.key, issue_number);

        let row = sqlx::query_as!(
            IssueRow,
            r#"INSERT INTO issues (
                   id, project_id, issue_number, simple_id, status_id, title,
                   description, priority, start_date, target_date, completed_at,
                   sort_order, parent_issue_id, parent_issue_sort_order,
                   extension_metadata
               ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
               )
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         issue_number,
                         simple_id,
                         status_id as "status_id!: Uuid",
                         title,
                         description,
                         priority,
                         start_date as "start_date: DateTime<Utc>",
                         target_date as "target_date: DateTime<Utc>",
                         completed_at as "completed_at: DateTime<Utc>",
                         sort_order as "sort_order!: f64",
                         parent_issue_id as "parent_issue_id: Uuid",
                         parent_issue_sort_order as "parent_issue_sort_order: f64",
                         extension_metadata,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            new.id,
            new.project_id,
            issue_number,
            simple_id,
            new.status_id,
            new.title,
            new.description,
            new.priority,
            new.start_date,
            new.target_date,
            new.completed_at,
            new.sort_order,
            new.parent_issue_id,
            new.parent_issue_sort_order,
            new.extension_metadata,
        )
        .fetch_one(pool)
        .await?;
        Ok(Issue::from(row))
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        u: IssueUpdate<'_>,
    ) -> Result<Option<Self>, sqlx::Error> {
        let row = sqlx::query_as!(
            IssueRow,
            r#"UPDATE issues
               SET status_id = $2,
                   title = $3,
                   description = $4,
                   priority = $5,
                   start_date = $6,
                   target_date = $7,
                   completed_at = $8,
                   sort_order = $9,
                   parent_issue_id = $10,
                   parent_issue_sort_order = $11,
                   extension_metadata = $12,
                   updated_at = datetime('now', 'subsec')
               WHERE id = $1
               RETURNING id as "id!: Uuid",
                         project_id as "project_id!: Uuid",
                         issue_number,
                         simple_id,
                         status_id as "status_id!: Uuid",
                         title,
                         description,
                         priority,
                         start_date as "start_date: DateTime<Utc>",
                         target_date as "target_date: DateTime<Utc>",
                         completed_at as "completed_at: DateTime<Utc>",
                         sort_order as "sort_order!: f64",
                         parent_issue_id as "parent_issue_id: Uuid",
                         parent_issue_sort_order as "parent_issue_sort_order: f64",
                         extension_metadata,
                         created_at as "created_at!: DateTime<Utc>",
                         updated_at as "updated_at!: DateTime<Utc>""#,
            id,
            u.status_id,
            u.title,
            u.description,
            u.priority,
            u.start_date,
            u.target_date,
            u.completed_at,
            u.sort_order,
            u.parent_issue_id,
            u.parent_issue_sort_order,
            u.extension_metadata,
        )
        .fetch_optional(pool)
        .await?;
        Ok(row.map(Issue::from))
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<u64, sqlx::Error> {
        let result = sqlx::query!("DELETE FROM issues WHERE id = $1", id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected())
    }
}
