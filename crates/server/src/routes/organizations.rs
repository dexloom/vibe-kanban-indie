use api_types::{
    GetOrganizationResponse, ListMembersResponse, ListOrganizationsResponse, MemberRole,
    Organization, OrganizationMemberWithProfile, OrganizationWithRole, UpdateOrganizationRequest,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    response::Json as ResponseJson,
    routing::{get, patch},
};
use chrono::Utc;
use db::models::{local_user::LocalUser, project::LOCAL_ORGANIZATION_ID};
use deployment::Deployment;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/organizations", get(list_organizations))
        .route("/organizations/{id}", get(get_organization))
        .route("/organizations/{id}", patch(update_organization))
        .route("/organizations/{org_id}/members", get(list_members))
}

async fn list_organizations(
    State(_deployment): State<DeploymentImpl>,
) -> Result<ResponseJson<ApiResponse<ListOrganizationsResponse>>, ApiError> {
    // Local-only fork: a single synthetic organization, no cloud account.
    let now = Utc::now();
    let response = ListOrganizationsResponse {
        organizations: vec![OrganizationWithRole {
            id: LOCAL_ORGANIZATION_ID,
            name: "Local".to_string(),
            slug: "local".to_string(),
            is_personal: false,
            issue_prefix: "LOCAL".to_string(),
            created_at: now,
            updated_at: now,
            user_role: MemberRole::Admin,
        }],
    };
    Ok(ResponseJson(ApiResponse::success(response)))
}

async fn get_organization(
    State(_deployment): State<DeploymentImpl>,
    Path(_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<GetOrganizationResponse>>, ApiError> {
    let now = Utc::now();
    let response = GetOrganizationResponse {
        organization: Organization {
            id: LOCAL_ORGANIZATION_ID,
            name: "Local".to_string(),
            slug: "local".to_string(),
            is_personal: false,
            issue_prefix: "LOCAL".to_string(),
            created_at: now,
            updated_at: now,
        },
        user_role: "admin".to_string(),
    };
    Ok(ResponseJson(ApiResponse::success(response)))
}

async fn update_organization(
    State(_deployment): State<DeploymentImpl>,
    Path(_id): Path<Uuid>,
    Json(_request): Json<UpdateOrganizationRequest>,
) -> Result<ResponseJson<ApiResponse<Organization>>, ApiError> {
    let now = Utc::now();
    let organization = Organization {
        id: LOCAL_ORGANIZATION_ID,
        name: "Local".to_string(),
        slug: "local".to_string(),
        is_personal: false,
        issue_prefix: "LOCAL".to_string(),
        created_at: now,
        updated_at: now,
    };
    Ok(ResponseJson(ApiResponse::success(organization)))
}

async fn list_members(
    State(deployment): State<DeploymentImpl>,
    Path(_org_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ListMembersResponse>>, ApiError> {
    let members = LocalUser::list_all(&deployment.db().pool)
        .await?
        .into_iter()
        .map(|u| OrganizationMemberWithProfile {
            user_id: u.id,
            role: MemberRole::Admin,
            joined_at: u.created_at,
            first_name: u.first_name,
            last_name: u.last_name,
            username: u.username,
            email: Some(u.email),
            avatar_url: None,
        })
        .collect();
    Ok(ResponseJson(ApiResponse::success(ListMembersResponse {
        members,
    })))
}
