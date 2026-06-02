use axum::{
    Router,
    extract::{State, ws::Message},
    http::StatusCode,
    response::{IntoResponse, Json as ResponseJson},
    routing::{get, post},
};
use deployment::Deployment;
use futures_util::StreamExt;
use serde::Deserialize;
use utils::approvals::ApprovalRequest;
use utils::{
    approvals::{ApprovalOutcome, ApprovalResponse},
    log_msg::LogMsg,
    response::ApiResponse,
};
use uuid::Uuid;

use crate::{
    DeploymentImpl,
    middleware::signed_ws::{MaybeSignedWebSocket, SignedWsUpgrade},
};

/// Subset of the Claude Code `PreToolUse` hook payload (delivered on the hook's
/// stdin) that the headed approval bridge needs. Extra fields are ignored.
#[derive(Debug, Deserialize)]
struct HeadedHookPayload {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    tool_use_id: Option<String>,
}

/// Build a Claude `PreToolUse` hook decision (the exact JSON the CLI reads back
/// from the hook command's stdout). `decision` is "allow" | "deny" | "ask".
fn hook_decision(decision: &str, reason: Option<&str>) -> serde_json::Value {
    let mut out = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    });
    if let Some(reason) = reason
        && let Some(obj) = out["hookSpecificOutput"].as_object_mut()
    {
        obj.insert(
            "permissionDecisionReason".to_string(),
            serde_json::Value::String(reason.to_string()),
        );
    }
    out
}

/// Headed (interactive tmux) approval bridge: a Claude `PreToolUse` command hook
/// POSTs its payload here and blocks on the response. We create an approval in
/// the SAME store the headless flow uses (so the existing WS stream + web UI +
/// `respond` endpoint drive it), wait for the operator's decision, then return
/// the hook-decision JSON that the CLI reads from the hook's stdout.
///
/// Fail-open: on any error we return `permissionDecision: "ask"` so Claude falls
/// back to its own in-TUI permission prompt rather than blocking forever.
async fn headed_approval_request(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(execution_process_id): axum::extract::Path<Uuid>,
    ResponseJson(payload): ResponseJson<HeadedHookPayload>,
) -> ResponseJson<serde_json::Value> {
    let tool_name = if payload.tool_name.is_empty() {
        "tool".to_string()
    } else {
        payload.tool_name.clone()
    };

    tracing::info!(
        "headed approval requested: exec={execution_process_id} tool={tool_name} \
         tool_use_id={:?}",
        payload.tool_use_id
    );

    let request = ApprovalRequest::new(tool_name.clone(), execution_process_id);
    let outcome = match deployment.approvals().create_and_wait(request, false).await {
        Ok(outcome) => outcome,
        Err(e) => {
            tracing::warn!(
                "headed approval bridge failed for exec={execution_process_id}: {e}; \
                 falling back to in-TUI prompt"
            );
            return ResponseJson(hook_decision(
                "ask",
                Some("vibe-kanban approval unavailable"),
            ));
        }
    };

    let decision = match outcome {
        ApprovalOutcome::Approved => hook_decision("allow", None),
        ApprovalOutcome::Denied { reason } => hook_decision(
            "deny",
            Some(reason.as_deref().unwrap_or("Denied in vibe-kanban")),
        ),
        ApprovalOutcome::TimedOut => hook_decision("deny", Some("Approval request timed out")),
        // Tool approvals never produce answers; defer to the TUI defensively.
        ApprovalOutcome::Answered { .. } => hook_decision("ask", None),
    };

    deployment
        .track_if_analytics_allowed(
            "headed_approval_resolved",
            serde_json::json!({
                "execution_process_id": execution_process_id.to_string(),
                "tool_name": tool_name,
            }),
        )
        .await;

    ResponseJson(decision)
}

async fn respond_to_approval(
    State(deployment): State<DeploymentImpl>,
    axum::extract::Path(id): axum::extract::Path<String>,
    ResponseJson(request): ResponseJson<ApprovalResponse>,
) -> Result<ResponseJson<ApiResponse<ApprovalOutcome>>, StatusCode> {
    let service = deployment.approvals();

    match service.respond(&id, request).await {
        Ok((outcome, context)) => {
            deployment
                .track_if_analytics_allowed(
                    "approval_responded",
                    serde_json::json!({
                        "approval_id": &id,
                        "status": format!("{:?}", outcome),
                        "tool_name": context.tool_name,
                        "execution_process_id": context.execution_process_id.to_string(),
                    }),
                )
                .await;

            Ok(ResponseJson(ApiResponse::success(outcome)))
        }
        Err(e) => {
            tracing::error!("Failed to respond to approval: {:?}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn stream_approvals_ws(
    ws: SignedWsUpgrade,
    State(deployment): State<DeploymentImpl>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_approvals_ws(socket, deployment).await {
            tracing::warn!("approvals WS closed: {}", e);
        }
    })
}

async fn handle_approvals_ws(
    mut socket: MaybeSignedWebSocket,
    deployment: DeploymentImpl,
) -> anyhow::Result<()> {
    let mut stream = deployment.approvals().patch_stream();

    if let Some(snapshot_patch) = stream.next().await {
        socket
            .send(LogMsg::JsonPatch(snapshot_patch).to_ws_message_unchecked())
            .await?;
    } else {
        return Ok(());
    }
    socket.send(LogMsg::Ready.to_ws_message_unchecked()).await?;

    loop {
        tokio::select! {
            patch = stream.next() => {
                let Some(patch) = patch else {
                    break;
                };

                if socket
                    .send(LogMsg::JsonPatch(patch).to_ws_message_unchecked())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Ok(Some(Message::Close(_))) => break,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(error) => {
                        tracing::warn!("approvals WS receive error: {}", error);
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

pub(super) fn router() -> Router<DeploymentImpl> {
    Router::new()
        .route("/approvals/{id}/respond", post(respond_to_approval))
        .route("/approvals/stream/ws", get(stream_approvals_ws))
        .route(
            "/headed-approvals/{execution_process_id}/request",
            post(headed_approval_request),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_decision_shapes_match_claude_contract() {
        let allow = hook_decision("allow", None);
        assert_eq!(allow["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(allow["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(
            allow["hookSpecificOutput"]
                .get("permissionDecisionReason")
                .is_none()
        );

        let deny = hook_decision("deny", Some("nope"));
        assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            deny["hookSpecificOutput"]["permissionDecisionReason"],
            "nope"
        );
    }

    #[test]
    fn headed_hook_payload_tolerates_extra_fields() {
        let raw = r#"{
            "session_id":"s","transcript_path":"/t","cwd":"/c",
            "permission_mode":"default","hook_event_name":"PreToolUse",
            "tool_name":"Bash","tool_input":{"command":"ls"},
            "tool_use_id":"toolu_1"
        }"#;
        let parsed: HeadedHookPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.tool_name, "Bash");
        assert_eq!(parsed.tool_use_id.as_deref(), Some("toolu_1"));
    }
}
