//! Tests for the TUI.
//!
//! - Render tests use ratatui's `TestBackend` to draw screens deterministically
//!   (no TTY needed) and assert the rendered buffer + that rendering never
//!   panics across loading/ready/empty/failed states.
//! - The contract test (ignored by default) hits a live backend and confirms the
//!   mirror structs in `api::types` still deserialize real payloads. Run with:
//!   `VIBE_BACKEND_URL=http://127.0.0.1:8910 cargo test -p tui -- --ignored`

use chrono::Utc;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use json_patch::Patch;
use ratatui::{Terminal, backend::TestBackend};
use serde_json::json;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::{
    api::{
        ApiClient,
        types::{GitRepoStatus, Issue, Project, ProjectStatus, Session, Workspace},
    },
    app::{
        App, AppEvent, CardField, Detail, DetailFocus, GitOp, KanbanView, Loadable, Modal, PrField,
        Screen,
    },
    state::conversation::{Conversation, Line, ToolBadge},
    ws::{Decoded, decode_frame},
};

fn stub_app() -> App {
    let client = ApiClient::with_base("http://127.0.0.1:0/api", "ws://127.0.0.1:0/api");
    let (tx, _rx) = mpsc::unbounded_channel();
    App::new(client, tx)
}

fn sample_workspace(name: &str) -> Workspace {
    let now = Utc::now();
    Workspace {
        id: Uuid::new_v4(),
        task_id: None,
        container_ref: None,
        branch: format!("vk/{name}"),
        setup_completed_at: None,
        created_at: now,
        updated_at: now,
        archived: false,
        pinned: false,
        name: Some(name.to_string()),
        worktree_deleted: false,
    }
}

fn sample_session(workspace_id: Uuid, name: &str) -> Session {
    let now = Utc::now();
    Session {
        id: Uuid::new_v4(),
        workspace_id,
        name: Some(name.to_string()),
        executor: Some("CLAUDE_CODE".to_string()),
        agent_working_dir: None,
        created_at: now,
        updated_at: now,
    }
}

/// Render the App and return the full text content of the buffer.
fn render_to_string(app: &App, w: u16, h: u16) -> String {
    let backend = TestBackend::new(w, h);
    let mut terminal = Terminal::new(backend).expect("test terminal");
    terminal
        .draw(|f| crate::ui::render(f, app))
        .expect("draw should not fail");
    terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect()
}

#[test]
fn renders_list_with_data() {
    let mut app = stub_app();
    let ws = sample_workspace("refactor-auth");
    let ws_id = ws.id;
    app.workspaces = Loadable::Ready(vec![ws, sample_workspace("fix-flaky-tests")]);
    app.ws_selected = 0;
    app.sessions = Loadable::Ready(vec![sample_session(ws_id, "attempt-1")]);
    app.sessions_for = Some(ws_id);

    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("refactor-auth"), "workspace name missing");
    assert!(text.contains("fix-flaky-tests"), "second workspace missing");
    assert!(text.contains("attempt-1"), "session label missing");
    assert!(text.contains("workspaces"), "workspaces pane title missing");
    assert!(text.contains("sessions"), "sessions pane title missing");
}

#[test]
fn renders_all_loadable_states_without_panic() {
    // Loading (default after new)
    let app = stub_app();
    let _ = render_to_string(&app, 80, 24);

    // Empty
    let mut app = stub_app();
    app.workspaces = Loadable::Ready(Vec::new());
    app.sessions = Loadable::Ready(Vec::new());
    let text = render_to_string(&app, 80, 24);
    assert!(text.contains("no workspaces"));

    // Failed
    let mut app = stub_app();
    app.workspaces = Loadable::Failed("connection refused".to_string());
    let text = render_to_string(&app, 80, 24);
    assert!(text.contains("error"));

    // Tiny terminal must not panic.
    let app = stub_app();
    let _ = render_to_string(&app, 4, 3);
}

fn sample_git_repo(name: &str, target: &str, ahead: usize, behind: usize) -> GitRepoStatus {
    GitRepoStatus {
        repo_id: Uuid::new_v4(),
        repo_name: name.to_string(),
        commits_ahead: Some(ahead),
        commits_behind: Some(behind),
        remote_commits_ahead: None,
        remote_commits_behind: None,
        has_uncommitted_changes: Some(false),
        uncommitted_count: Some(0),
        target_branch_name: target.to_string(),
        is_rebase_in_progress: false,
        conflict_op: None,
        conflicted_files: Vec::new(),
        is_target_remote: false,
    }
}

#[test]
fn renders_git_pane_with_multiple_repos() {
    let mut app = stub_app();
    let ws = sample_workspace("snake");
    let ws_id = ws.id;
    app.workspaces = Loadable::Ready(vec![ws]);
    app.sessions = Loadable::Ready(vec![sample_session(ws_id, "attempt-1")]);
    app.sessions_for = Some(ws_id);
    app.detail = Some(Detail::for_test(
        ws_id,
        vec![
            sample_git_repo("vksnake", "main", 3, 1),
            sample_git_repo("ui", "main", 0, 0),
        ],
    ));
    app.screen = Screen::Detail;

    let text = render_to_string(&app, 120, 30);
    assert!(text.contains("git"), "git pane title missing");
    assert!(text.contains("vksnake"), "first repo missing");
    assert!(text.contains("ui"), "second repo missing");
    assert!(text.contains("merge"), "action hints missing");
}

#[test]
fn detail_tab_cycles_pane_focus() {
    let mut app = stub_app();
    let ws = sample_workspace("snake");
    let ws_id = ws.id;
    app.workspaces = Loadable::Ready(vec![ws]);
    app.detail = Some(Detail::for_test(
        ws_id,
        vec![sample_git_repo("vksnake", "main", 1, 0)],
    ));
    app.screen = Screen::Detail;

    let focus = |app: &App| app.detail.as_ref().unwrap().focus;
    let tab = || AppEvent::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));

    assert_eq!(focus(&app), DetailFocus::Transcript);
    app.update(tab());
    assert_eq!(focus(&app), DetailFocus::Processes);
    app.update(tab());
    assert_eq!(focus(&app), DetailFocus::Git);
    app.update(tab());
    assert_eq!(focus(&app), DetailFocus::Transcript, "focus wraps around");

    // ↑↓ in the git pane moves the repo selection, not the transcript.
    app.update(tab()); // → Processes
    app.update(tab()); // → Git
    app.detail
        .as_mut()
        .unwrap()
        .git
        .push(sample_git_repo("ui", "main", 0, 0));
    app.update(AppEvent::Key(KeyEvent::new(
        KeyCode::Down,
        KeyModifiers::NONE,
    )));
    assert_eq!(app.detail.as_ref().unwrap().repo_selected, 1);
}

#[test]
fn renders_git_modals_without_panic() {
    // Confirm modal for a destructive op.
    let mut app = stub_app();
    app.modal = Some(Modal::ConfirmGit {
        op: GitOp::Merge,
        workspace_id: Uuid::new_v4(),
        repo_id: Uuid::new_v4(),
        repo_name: "vksnake".into(),
        target: "main".into(),
    });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("Merge"), "merge confirm missing");

    // Create-PR form.
    let mut app = stub_app();
    app.modal = Some(Modal::PrForm {
        workspace_id: Uuid::new_v4(),
        repo_id: Uuid::new_v4(),
        repo_name: "vksnake".into(),
        target: "main".into(),
        title: "Add snake game".into(),
        body: String::new(),
        field: PrField::Title,
    });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("create PR"), "PR form title missing");
    assert!(text.contains("Add snake game"), "PR title value missing");

    // Tiny terminal must not panic with a detail + git data.
    let mut app = stub_app();
    app.detail = Some(Detail::for_test(
        Uuid::new_v4(),
        vec![sample_git_repo("vksnake", "main", 1, 0)],
    ));
    app.screen = Screen::Detail;
    let _ = render_to_string(&app, 6, 4);
}

fn sample_kanban() -> KanbanView {
    let project_id = Uuid::new_v4();
    let status_id = Uuid::new_v4();
    let issue = Issue {
        id: Uuid::new_v4(),
        project_id,
        status_id,
        simple_id: "ACME-1".into(),
        title: "Wire up login".into(),
        description: Some("Add OAuth".into()),
        priority: Some("high".into()),
        sort_order: 0.0,
        parent_issue_id: None,
    };
    let mut issues_by_status = std::collections::HashMap::new();
    issues_by_status.insert(status_id, vec![issue]);
    KanbanView {
        projects: vec![Project {
            id: project_id,
            name: "Acme".into(),
            color: "#6366f1".into(),
            sort_order: 0,
        }],
        project_idx: 0,
        statuses: vec![ProjectStatus {
            id: status_id,
            project_id,
            name: "Todo".into(),
            color: "#6366f1".into(),
            sort_order: 0,
            hidden: false,
        }],
        issues_by_status,
        workspaces: Vec::new(),
        col_idx: 0,
        card_idx: 0,
        loading: false,
        error: None,
        pending_link: None,
    }
}

#[test]
fn renders_kanban_board() {
    let mut app = stub_app();
    app.kanban = Some(sample_kanban());
    app.screen = Screen::Kanban;

    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("Acme"), "project name missing");
    assert!(text.contains("Todo"), "column name missing");
    assert!(text.contains("ACME-1"), "card simple_id missing");
    assert!(text.contains("Wire up login"), "card title missing");
}

#[test]
fn renders_kanban_states_without_panic() {
    // No projects (loading).
    let mut app = stub_app();
    app.kanban = Some(KanbanView {
        projects: Vec::new(),
        project_idx: 0,
        statuses: Vec::new(),
        issues_by_status: std::collections::HashMap::new(),
        workspaces: Vec::new(),
        col_idx: 0,
        card_idx: 0,
        loading: true,
        error: None,
        pending_link: None,
    });
    app.screen = Screen::Kanban;
    let _ = render_to_string(&app, 80, 24);

    // Populated board on a tiny terminal must not panic.
    let mut app = stub_app();
    app.kanban = Some(sample_kanban());
    app.screen = Screen::Kanban;
    let _ = render_to_string(&app, 6, 4);
}

#[test]
fn renders_card_modals_without_panic() {
    let mut app = stub_app();
    let kv = sample_kanban();
    let issue_id = kv
        .issues_by_status
        .values()
        .flatten()
        .next()
        .expect("a card")
        .id;
    app.kanban = Some(kv);
    app.screen = Screen::Kanban;

    // Create-card form.
    app.modal = Some(Modal::CardForm {
        editing: None,
        title: "New thing".into(),
        description: String::new(),
        status_idx: 0,
        priority_idx: 2,
        field: CardField::Title,
    });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("new card"), "card form title missing");

    // Read-only card detail.
    app.modal = Some(Modal::CardDetail { issue_id });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("ACME-1"), "detail simple_id missing");
    assert!(
        text.contains("workspaces"),
        "detail workspaces section missing"
    );
}

#[test]
fn step_clamps_within_bounds() {
    use crate::app::step;
    assert_eq!(step(0, -1, 3), 0, "cannot go below 0");
    assert_eq!(step(2, 1, 3), 2, "cannot exceed last index");
    assert_eq!(step(1, 1, 3), 2);
    assert_eq!(step(1, -1, 3), 0);
    assert_eq!(step(0, 1, 0), 0, "empty list stays at 0");
}

// ---- T-M2: WS frame decoding ----

#[test]
fn decode_sentinels_and_patch() {
    assert!(matches!(decode_frame(r#"{"Ready":true}"#), Decoded::Ready));
    assert!(matches!(
        decode_frame(r#"{"finished":true}"#),
        Decoded::Finished
    ));
    // A LogMsg::JsonPatch frame (externally-tagged enum).
    let frame = r#"{"JsonPatch":[{"op":"add","path":"/entries/0","value":{"type":"STDOUT","content":"hi"}}]}"#;
    assert!(matches!(decode_frame(frame), Decoded::Patch(_)));
    // Garbage decodes to Other, never panics.
    assert!(matches!(decode_frame("not json"), Decoded::Other));
}

// ---- T-M2: conversation projection ----

fn add_entry(index: u64, value: serde_json::Value) -> Patch {
    serde_json::from_value(json!([{
        "op": "add",
        "path": format!("/entries/{index}"),
        "value": value,
    }]))
    .expect("valid patch")
}

fn normalized(entry_type: serde_json::Value, content: &str) -> serde_json::Value {
    json!({
        "type": "NORMALIZED_ENTRY",
        "content": {
            "timestamp": null,
            "entry_type": entry_type,
            "content": content,
            "metadata": null,
        }
    })
}

#[test]
fn conversation_projects_messages_and_tools() {
    let mut c = Conversation::new();
    c.apply(&add_entry(
        0,
        normalized(json!({"type": "assistant_message"}), "Hello"),
    ))
    .unwrap();
    c.apply(&add_entry(
        1,
        normalized(
            json!({
                "type": "tool_use",
                "tool_name": "Bash",
                "action_type": {"action": "command_run", "command": "git push origin main"},
                "status": {"status": "pending_approval", "approval_id": "appr-1"}
            }),
            "",
        ),
    ))
    .unwrap();

    let lines = c.lines();
    assert_eq!(lines.len(), 2);
    match &lines[0] {
        Line::Assistant(s) => assert_eq!(s, "Hello"),
        other => panic!("expected assistant, got {other:?}"),
    }
    match &lines[1] {
        Line::Tool {
            name,
            badge,
            summary,
            approval_id,
        } => {
            assert_eq!(name, "Bash");
            assert_eq!(*badge, ToolBadge::PendingApproval);
            assert_eq!(summary, "git push origin main");
            assert_eq!(approval_id.as_deref(), Some("appr-1"));
        }
        other => panic!("expected tool, got {other:?}"),
    }
    assert_eq!(c.pending_approval_ids(), vec!["appr-1".to_string()]);
}

#[test]
fn conversation_handles_replace_remove_and_ordering() {
    let mut c = Conversation::new();
    // Insert out of order; projection must sort by integer key.
    c.apply(&add_entry(
        2,
        normalized(json!({"type": "assistant_message"}), "second"),
    ))
    .unwrap();
    c.apply(&add_entry(
        0,
        normalized(json!({"type": "user_message"}), "first"),
    ))
    .unwrap();
    let lines = c.lines();
    assert!(matches!(&lines[0], Line::User(s) if s == "first"));
    assert!(matches!(&lines[1], Line::Assistant(s) if s == "second"));

    // Replace entry 2 (e.g. tool transitions from pending to success).
    let replace: Patch = serde_json::from_value(json!([{
        "op": "replace",
        "path": "/entries/2",
        "value": normalized(json!({"type": "assistant_message"}), "second-edited"),
    }]))
    .unwrap();
    c.apply(&replace).unwrap();
    assert!(matches!(&c.lines()[1], Line::Assistant(s) if s == "second-edited"));

    // Remove entry 0.
    let remove: Patch =
        serde_json::from_value(json!([{ "op": "remove", "path": "/entries/0" }])).unwrap();
    c.apply(&remove).unwrap();
    let lines = c.lines();
    assert_eq!(lines.len(), 1);
    assert!(matches!(&lines[0], Line::Assistant(s) if s == "second-edited"));
}

#[test]
fn conversation_tolerates_unknown_variant() {
    let mut c = Conversation::new();
    c.apply(&add_entry(
        0,
        normalized(
            json!({"type": "some_future_variant", "extra": 1}),
            "payload",
        ),
    ))
    .unwrap();
    // Unknown variant degrades to Other rather than dropping/panicking.
    assert!(matches!(&c.lines()[0], Line::Other(_)));
}

// ---- T-M2: process list projection ----

#[test]
fn process_list_projects_and_sorts() {
    use crate::{
        api::types::{ProcStatus, RunReason},
        state::processes::ProcessList,
    };

    let mk = |id: &str, started: &str, reason: &str, status: &str| {
        json!({
            "id": id,
            "session_id": "00000000-0000-0000-0000-0000000000aa",
            "run_reason": reason,
            "status": status,
            "exit_code": null,
            "dropped": false,
            "started_at": started,
            "completed_at": null,
            "created_at": started,
            "updated_at": started,
        })
    };

    let mut pl = ProcessList::new();
    // Insert newest first; projection must sort oldest → newest by started_at.
    let p_new = "11111111-1111-1111-1111-111111111111";
    let p_old = "22222222-2222-2222-2222-222222222222";
    let patch: Patch = serde_json::from_value(json!([
        {"op": "add", "path": format!("/execution_processes/{p_new}"),
         "value": mk(p_new, "2026-05-23T03:00:00Z", "codingagent", "running")},
        {"op": "add", "path": format!("/execution_processes/{p_old}"),
         "value": mk(p_old, "2026-05-23T01:00:00Z", "setupscript", "completed")},
    ]))
    .unwrap();
    pl.apply(&patch).unwrap();

    let procs = pl.processes();
    assert_eq!(procs.len(), 2);
    assert_eq!(
        procs[0].started_at.to_rfc3339(),
        "2026-05-23T01:00:00+00:00"
    );
    assert_eq!(procs[0].run_reason, RunReason::SetupScript);
    assert_eq!(procs[0].status, ProcStatus::Completed);
    assert_eq!(procs[1].run_reason, RunReason::CodingAgent);
    assert_eq!(procs[1].status, ProcStatus::Running);
}

// ---- T-M4: create form + follow-up + request shapes ----

fn sample_repo(name: &str) -> crate::api::types::Repo {
    crate::api::types::Repo {
        id: Uuid::new_v4(),
        name: name.to_string(),
        display_name: name.to_string(),
        default_target_branch: Some("main".to_string()),
    }
}

#[test]
fn create_form_renders() {
    use crate::app::{CreateField, CreateForm, Screen};

    let mut app = stub_app();
    app.screen = Screen::Create;
    app.create = Some(CreateForm {
        name: "refactor".to_string(),
        prompt: "split the module".to_string(),
        repos: Loadable::Ready(vec![sample_repo("my-repo")]),
        repo_idx: 0,
        preferred_repo_ids: Vec::new(),
        branch: "main".to_string(),
        executor_idx: 0,
        field: CreateField::Prompt,
        submitting: false,
    });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("new task"), "form title missing");
    assert!(text.contains("split the module"), "prompt missing");
    assert!(text.contains("my-repo"), "repo name missing");
    assert!(text.contains("CLAUDE_CODE"), "executor missing");
}

#[test]
fn create_form_preselects_project_repo() {
    use crate::app::{AppEvent, CreateField, CreateForm, Screen};

    let repo_a = sample_repo("vibe-kanban"); // global list order: first
    let repo_b = sample_repo("vksnake"); // the project's repo
    let b_id = repo_b.id;

    let mut app = stub_app();
    app.screen = Screen::Create;
    app.create = Some(CreateForm {
        name: String::new(),
        prompt: "change snake color".to_string(),
        repos: Loadable::Loading,
        repo_idx: 0,
        preferred_repo_ids: Vec::new(),
        branch: String::new(),
        executor_idx: 0,
        field: CreateField::Prompt,
        submitting: false,
    });

    // Project's repos arrive first (vksnake), then the global list (A then B).
    app.update(AppEvent::ProjectRepos(Ok(vec![repo_b.clone()])));
    app.update(AppEvent::Repos(Ok(vec![repo_a.clone(), repo_b.clone()])));

    let form = app.create.as_ref().unwrap();
    assert_eq!(
        form.repo_idx, 1,
        "should preselect the project's repo (vksnake)"
    );
    assert_eq!(form.preferred_repo_ids, vec![b_id]);

    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("vksnake"), "selected repo shown");
    assert!(text.contains("project repo"), "project-repo marker shown");
}

#[test]
fn followup_modal_renders() {
    use crate::app::Modal;

    let mut app = stub_app();
    app.modal = Some(Modal::FollowUp {
        session_id: Uuid::new_v4(),
        executor: "CLAUDE_CODE".to_string(),
        buffer: "please continue".to_string(),
        queue: false,
        interactive: false,
    });
    let text = render_to_string(&app, 100, 24);
    assert!(text.contains("message to agent"), "modal title missing");
    assert!(text.contains("please continue"), "buffer missing");
    assert!(text.contains("send now"), "mode label missing");
}

#[test]
fn request_bodies_serialize_to_backend_shape() {
    use crate::api::types::{
        CreateAndStartRequest, ExecutorConfigInput, FollowUpRequest, WorkspaceRepoInput,
    };

    let repo_id = Uuid::new_v4();
    let req = CreateAndStartRequest {
        name: Some("t".to_string()),
        repos: vec![WorkspaceRepoInput {
            repo_id,
            target_branch: "main".to_string(),
        }],
        linked_issue: None,
        executor_config: ExecutorConfigInput::new("CLAUDE_CODE"),
        prompt: "go".to_string(),
        attachment_ids: None,
    };
    let v = serde_json::to_value(&req).unwrap();
    assert_eq!(v["executor_config"]["executor"], "CLAUDE_CODE");
    assert_eq!(v["repos"][0]["repo_id"], repo_id.to_string());
    assert_eq!(v["repos"][0]["target_branch"], "main");
    assert_eq!(v["prompt"], "go");

    let fu = FollowUpRequest {
        prompt: "next".to_string(),
        executor_config: ExecutorConfigInput::new("CODEX"),
        interactive: None,
    };
    let v = serde_json::to_value(&fu).unwrap();
    assert_eq!(v["prompt"], "next");
    assert_eq!(v["executor_config"]["executor"], "CODEX");
}

// ---- T-M3: approvals inbox projection ----

fn approval_info(id: &str, is_question: bool, created: &str) -> serde_json::Value {
    json!({
        "approval_id": id,
        "tool_name": if is_question { "AskUserQuestion" } else { "Bash" },
        "execution_process_id": "00000000-0000-0000-0000-0000000000ee",
        "is_question": is_question,
        "created_at": created,
        "timeout_at": "2026-05-23T13:00:00Z",
    })
}

#[test]
fn approval_inbox_snapshot_created_resolved() {
    use crate::state::approvals::ApprovalInbox;

    let mut inbox = ApprovalInbox::new();
    // Snapshot with one approval.
    let snapshot: Patch = serde_json::from_value(json!([{
        "op": "replace",
        "path": "/pending",
        "value": { "a1": approval_info("a1", false, "2026-05-23T03:00:00Z") },
    }]))
    .unwrap();
    inbox.apply(&snapshot).unwrap();
    assert_eq!(inbox.len(), 1);

    // A second approval is created (sorts after a1 by created_at).
    let created: Patch = serde_json::from_value(json!([{
        "op": "replace",
        "path": "/pending/a2",
        "value": approval_info("a2", true, "2026-05-23T03:05:00Z"),
    }]))
    .unwrap();
    inbox.apply(&created).unwrap();
    let list = inbox.approvals();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].approval_id, "a1");
    assert_eq!(list[1].approval_id, "a2");
    assert!(list[1].is_question);

    // a1 resolved → removed.
    let resolved: Patch =
        serde_json::from_value(json!([{ "op": "remove", "path": "/pending/a1" }])).unwrap();
    inbox.apply(&resolved).unwrap();
    let list = inbox.approvals();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].approval_id, "a2");
}

#[test]
fn conversation_finds_question_options() {
    let mut c = Conversation::new();
    c.apply(&add_entry(
        0,
        normalized(
            json!({
                "type": "tool_use",
                "tool_name": "AskUserQuestion",
                "action_type": {
                    "action": "ask_user_question",
                    "questions": [{
                        "question": "Which migration strategy?",
                        "header": "Strategy",
                        "options": [
                            {"label": "Option A", "description": "in-place"},
                            {"label": "Option B", "description": "shadow table"}
                        ],
                        "multiSelect": false
                    }]
                },
                "status": {"status": "pending_approval", "approval_id": "q-1"}
            }),
            "",
        ),
    ))
    .unwrap();

    let qs = c.find_questions("q-1").expect("question found");
    assert_eq!(qs.len(), 1);
    assert_eq!(qs[0].header, "Strategy");
    assert_eq!(
        qs[0].options,
        vec!["Option A".to_string(), "Option B".to_string()]
    );
    assert!(!qs[0].multi_select);

    // No match for an unrelated id.
    assert!(c.find_questions("nope").is_none());
}

/// Confirms the `api::types` mirror structs deserialize real backend payloads.
/// Ignored by default — requires a running backend (set `VIBE_BACKEND_URL` or
/// rely on the port-file discovery).
#[tokio::test]
#[ignore = "requires a running backend"]
async fn contract_workspaces_and_sessions_deserialize() {
    let client = ApiClient::connect().await.expect("connect to backend");
    let workspaces = client
        .list_workspaces()
        .await
        .expect("list_workspaces deserializes");
    // If any workspaces exist, their sessions must deserialize too.
    if let Some(w) = workspaces.first() {
        client
            .list_sessions(w.id)
            .await
            .expect("list_sessions deserializes");
    }
}

/// Confirms the kanban mirror structs (`Project`, `ProjectStatus`, `Issue`,
/// `RemoteWorkspace`) deserialize real `/v1/*` payloads. Ignored by default.
#[tokio::test]
#[ignore = "requires a running backend"]
async fn contract_kanban_types_deserialize() {
    let client = ApiClient::connect().await.expect("connect to backend");
    let projects = client
        .list_projects()
        .await
        .expect("list_projects deserializes");
    if let Some(p) = projects.first() {
        client
            .list_statuses(p.id)
            .await
            .expect("list_statuses deserializes");
        client
            .list_issues(p.id)
            .await
            .expect("list_issues deserializes");
        client
            .list_project_workspaces(p.id)
            .await
            .expect("list_project_workspaces deserializes");
    }
}

/// Confirms the git mirror structs (`GitRepoStatus`, `WorkspaceSummary`)
/// deserialize real `/api/workspaces/{id}/git/status` and `/summaries`
/// payloads. Ignored by default — requires a running backend with a workspace.
#[tokio::test]
#[ignore = "requires a running backend with a workspace"]
async fn contract_git_types_deserialize() {
    let client = ApiClient::connect().await.expect("connect to backend");
    let workspaces = client.list_workspaces().await.expect("list_workspaces");
    if let Some(w) = workspaces.first() {
        client
            .git_status(w.id)
            .await
            .expect("git_status deserializes");
        client
            .workspace_summary(w.id)
            .await
            .expect("workspace_summary deserializes");
    }
}

/// Smoke-tests the WS layer end-to-end: connects to a session's execution-process
/// stream and confirms the snapshot/`Ready` handshake arrives and decodes.
/// Ignored by default — requires a running backend with at least one session.
#[tokio::test]
#[ignore = "requires a running backend with a session"]
async fn contract_session_process_stream_handshake() {
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::ws::{self, Decoded, StreamEvent};

    let client = ApiClient::connect().await.expect("connect");
    let workspaces = client.list_workspaces().await.expect("workspaces");

    // Find any workspace that has at least one session.
    let mut session_id = None;
    for w in &workspaces {
        let sessions = client.list_sessions(w.id).await.expect("sessions");
        if let Some(s) = sessions.first() {
            session_id = Some(s.id);
            break;
        }
    }
    let session_id = session_id.expect("at least one workspace with a session");

    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = ws::spawn_stream(client.session_processes_ws(session_id), tx, |e| e);

    // Expect the snapshot patch and/or Ready within a short window.
    let mut saw_ready_or_patch = false;
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            ev = rx.recv() => match ev {
                Some(StreamEvent::Frame(Decoded::Ready | Decoded::Patch(_))) => {
                    saw_ready_or_patch = true;
                    break;
                }
                Some(StreamEvent::Closed) | None => break,
                Some(_) => {}
            }
        }
    }
    assert!(
        saw_ready_or_patch,
        "expected a snapshot patch or Ready from the session-process stream"
    );
}

/// Smoke-tests the global approvals stream: connect and confirm the snapshot →
/// `Ready` handshake. Ignored by default — requires a running backend.
#[tokio::test]
#[ignore = "requires a running backend"]
async fn contract_approvals_stream_handshake() {
    use std::time::Duration;

    use tokio::sync::mpsc;

    use crate::ws::{self, Decoded, StreamEvent};

    let client = ApiClient::connect().await.expect("connect");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = ws::spawn_stream(client.approvals_ws(), tx, |e| e);

    let mut ok = false;
    let deadline = tokio::time::sleep(Duration::from_secs(5));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            ev = rx.recv() => match ev {
                Some(StreamEvent::Frame(Decoded::Ready | Decoded::Patch(_))) => { ok = true; break; }
                Some(StreamEvent::Closed) | None => break,
                Some(_) => {}
            }
        }
    }
    assert!(ok, "expected snapshot/Ready from the approvals stream");
}
