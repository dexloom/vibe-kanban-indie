use api_types::{
    AcceptInvitationResponse, CreateInvitationRequest, CreateInvitationResponse,
    CreateOrganizationRequest, CreateOrganizationResponse, GetInvitationResponse,
    GetOrganizationResponse, ListInvitationsResponse, ListMembersResponse,
    ListOrganizationsResponse, MemberRole, Organization, OrganizationMemberWithProfile,
    OrganizationWithRole, UpdateMemberRoleRequest, UpdateMemberRoleResponse,
    UpdateOrganizationRequest,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::Json as ResponseJson,
    routing::{delete, get, patch, post},
};
use chrono::Utc;
use db::models::{local_user::LocalUser, project::LOCAL_ORGANIZATION_ID};
use deployment::Deployment;
use serde::Deserialize;
use utils::response::ApiResponse;
use uuid::Uuid;

use crate::{DeploymentImpl, error::ApiError};

pub fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/organizations", get(list_organizations))
        .route("/organizations", post(create_organization))
        .route("/organizations/{id}", get(get_organization))
        .route("/organizations/{id}", patch(update_organization))
        .route("/organizations/{id}", delete(delete_organization))
        .route(
            "/organizations/{org_id}/invitations",
            post(create_invitation),
        )
        .route("/organizations/{org_id}/invitations", get(list_invitations))
        .route(
            "/organizations/{org_id}/invitations/revoke",
            post(revoke_invitation),
        )
        .route("/invitations/{token}", get(get_invitation))
        .route("/invitations/{token}/accept", post(accept_invitation))
        .route("/organizations/{org_id}/members", get(list_members))
        .route(
            "/organizations/{org_id}/members/{user_id}",
            delete(remove_member),
        )
        .route(
            "/organizations/{org_id}/members/{user_id}/role",
            patch(update_member_role),
        )
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

#[derive(Debug, Deserialize)]
struct EmptyOrgCreate;

async fn create_organization(
    State(_deployment): State<DeploymentImpl>,
    Json(_request): Json<CreateOrganizationRequest>,
) -> Result<ResponseJson<ApiResponse<CreateOrganizationResponse>>, ApiError> {
    // Local-only fork: ignore the request and return a stub response.
    let now = Utc::now();
    let response = CreateOrganizationResponse {
        organization: OrganizationWithRole {
            id: LOCAL_ORGANIZATION_ID,
            name: "Local".to_string(),
            slug: "local".to_string(),
            is_personal: false,
            issue_prefix: "LOCAL".to_string(),
            created_at: now,
            updated_at: now,
            user_role: MemberRole::Admin,
        },
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

async fn delete_organization(
    State(_deployment): State<DeploymentImpl>,
    Path(_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    Err(ApiError::BadRequest(
        "Organization deletion is not supported in the local-only fork".to_string(),
    ))
}

async fn create_invitation(
    State(_deployment): State<DeploymentImpl>,
    Path(_org_id): Path<Uuid>,
    Json(_request): Json<CreateInvitationRequest>,
) -> Result<ResponseJson<ApiResponse<CreateInvitationResponse>>, ApiError> {
    Err(ApiError::BadRequest(
        "Invitations are not supported in the local-only fork".to_string(),
    ))
}

async fn list_invitations(
    State(_deployment): State<DeploymentImpl>,
    Path(_org_id): Path<Uuid>,
) -> Result<ResponseJson<ApiResponse<ListInvitationsResponse>>, ApiError> {
    Ok(ResponseJson(ApiResponse::success(
        ListInvitationsResponse {
            invitations: Vec::new(),
        },
    )))
}

async fn get_invitation(
    State(_deployment): State<DeploymentImpl>,
    Path(_token): Path<String>,
) -> Result<ResponseJson<ApiResponse<GetInvitationResponse>>, ApiError> {
    Err(ApiError::BadRequest(
        "Invitations are not supported in the local-only fork".to_string(),
    ))
}

async fn revoke_invitation(
    State(_deployment): State<DeploymentImpl>,
    Path(_org_id): Path<Uuid>,
    Json(_payload): Json<api_types::RevokeInvitationRequest>,
) -> Result<StatusCode, ApiError> {
    Err(ApiError::BadRequest(
        "Invitations are not supported in the local-only fork".to_string(),
    ))
}

async fn accept_invitation(
    State(_deployment): State<DeploymentImpl>,
    Path(_invitation_token): Path<String>,
) -> Result<ResponseJson<ApiResponse<AcceptInvitationResponse>>, ApiError> {
    Err(ApiError::BadRequest(
        "Invitations are not supported in the local-only fork".to_string(),
    ))
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

async fn remove_member(
    State(_deployment): State<DeploymentImpl>,
    Path((_org_id, _user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    Err(ApiError::BadRequest(
        "Member management is not supported in the local-only fork".to_string(),
    ))
}

async fn update_member_role(
    State(_deployment): State<DeploymentImpl>,
    Path((_org_id, _user_id)): Path<(Uuid, Uuid)>,
    Json(_request): Json<UpdateMemberRoleRequest>,
) -> Result<ResponseJson<ApiResponse<UpdateMemberRoleResponse>>, ApiError> {
    Err(ApiError::BadRequest(
        "Member management is not supported in the local-only fork".to_string(),
    ))
}

// Touch the helper so the unused-import lint is satisfied.
#[allow(dead_code)]
fn _silence_unused(_: EmptyOrgCreate) {}
