use api_types::ListProjectsResponse;
use rmcp::{
    ErrorData, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::McpServer;

#[derive(Debug, Default, Deserialize, schemars::JsonSchema)]
struct McpListProjectsRequest {
    #[schemars(
        description = "Optional organization ID. Ignored in local mode (a single implicit organization)."
    )]
    #[serde(default)]
    #[allow(dead_code)] // accepted for compatibility; local mode has one org
    organization_id: Option<Uuid>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct ProjectSummary {
    #[schemars(description = "The unique identifier of the project")]
    id: String,
    #[schemars(description = "The name of the project")]
    name: String,
    #[schemars(description = "When the project was created")]
    created_at: String,
    #[schemars(description = "When the project was last updated")]
    updated_at: String,
}

impl ProjectSummary {
    fn from_remote_project(project: api_types::Project) -> Self {
        Self {
            id: project.id.to_string(),
            name: project.name,
            created_at: project.created_at.to_rfc3339(),
            updated_at: project.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
struct McpListProjectsResponse {
    projects: Vec<ProjectSummary>,
    count: usize,
}

#[tool_router(router = remote_projects_tools_router, vis = "pub")]
impl McpServer {
    #[tool(description = "List all the available projects")]
    async fn list_projects(
        &self,
        Parameters(McpListProjectsRequest { organization_id: _ }): Parameters<
            McpListProjectsRequest,
        >,
    ) -> Result<CallToolResult, ErrorData> {
        let url = self.url("/api/projects");
        let response: ListProjectsResponse = match self.send_json(self.client.get(&url)).await {
            Ok(r) => r,
            Err(e) => return Ok(Self::tool_error(e)),
        };

        let project_summaries: Vec<ProjectSummary> = response
            .projects
            .into_iter()
            .map(ProjectSummary::from_remote_project)
            .collect();

        McpServer::success(&McpListProjectsResponse {
            count: project_summaries.len(),
            projects: project_summaries,
        })
    }
}
