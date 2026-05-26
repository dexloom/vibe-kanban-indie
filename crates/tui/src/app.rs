//! Application state + the `update` reducer.
//!
//! The render loop feeds a single `AppEvent` stream into `App::update`, which
//! mutates state and may spawn async commands (REST calls and WS stream tasks
//! that post results back as further `AppEvent`s via `tx`). `update` never
//! blocks and never draws.
//!
//! WS streams are tagged with a `generation` (bumped each time the Detail screen
//! opens/closes) and log streams additionally with a `log_token` (bumped when
//! the watched process changes), so stale frames from superseded streams are
//! ignored even before their tasks finish aborting.

use std::collections::HashMap;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tokio::{sync::mpsc::UnboundedSender, task::JoinHandle};
use uuid::Uuid;

use crate::{
    api::{
        ApiClient, PushResult,
        types::{
            CreateAndStartRequest, CreateIssueRequest, CreatePrRequest, EXECUTORS,
            ExecutionProcess, ExecutorConfigInput, FollowUpRequest, GitRepoStatus, Issue,
            PRIORITIES, Project, ProjectStatus, QueueRequest, RemoteWorkspace, Repo, RunReason,
            Session, Workspace, WorkspaceRepoInput, WorkspaceSummary,
        },
    },
    state::{
        approvals::ApprovalInbox,
        conversation::{Conversation, QuestionItem},
        processes::ProcessList,
    },
    ws::{self, Decoded, StreamEvent},
};

/// Everything that can drive a state transition.
pub enum AppEvent {
    Key(KeyEvent),
    /// Terminal resized; the loop redraws on any event, so no payload is needed.
    Resize,
    Tick,
    Health(Result<(), String>),
    Workspaces(Result<Vec<Workspace>, String>),
    Sessions {
        workspace_id: Uuid,
        result: Result<Vec<Session>, String>,
    },
    /// A frame (or close) from the per-session execution-process stream.
    ProcStream {
        generation: u64,
        event: StreamEvent,
    },
    /// A frame (or close) from a process's normalized-log stream.
    LogStream {
        generation: u64,
        log_token: u64,
        event: StreamEvent,
    },
    /// A frame (or close) from the global approvals stream.
    ApprovalStream(StreamEvent),
    /// Re-open the approvals stream after a disconnect (debounced).
    ReconnectApprovals,
    /// Result of POSTing an approval response.
    ApprovalResponded {
        approval_id: String,
        result: Result<(), String>,
    },
    /// Options fetched (lazily) for answering a question approval.
    QuestionOptions {
        approval_id: String,
        questions: Vec<QuestionItem>,
    },
    /// Repos loaded for the create-task form.
    Repos(Result<Vec<Repo>, String>),
    /// Result of creating + starting a workspace (carries the new workspace id).
    Created(Result<Uuid, String>),
    /// Projects loaded for the kanban board.
    Projects(Result<Vec<Project>, String>),
    /// Kanban columns (statuses) loaded for a project.
    KanbanStatuses {
        project_id: Uuid,
        result: Result<Vec<ProjectStatus>, String>,
    },
    /// Kanban cards (issues) loaded for a project.
    KanbanIssues {
        project_id: Uuid,
        result: Result<Vec<Issue>, String>,
    },
    /// Workspaces linked to cards in a project.
    KanbanWorkspaces {
        project_id: Uuid,
        result: Result<Vec<RemoteWorkspace>, String>,
    },
    /// Result of a card mutation (create/edit/move/delete); reloads the board.
    KanbanMutated(Result<String, String>),
    /// Result of linking a launched workspace to a card.
    WorkspaceLinked(Result<(), String>),
    /// Per-repo git status for the open detail's workspace.
    GitStatus {
        workspace_id: Uuid,
        result: Result<Vec<GitRepoStatus>, String>,
    },
    /// Diff-stat + PR summary for the open detail's workspace.
    GitSummary {
        workspace_id: Uuid,
        result: Result<Option<WorkspaceSummary>, String>,
    },
    /// Result of a git action (merge / rebase / force-push / create PR). The
    /// `Ok` payload is a toast message; success reloads git status.
    GitActionDone {
        workspace_id: Uuid,
        result: Result<String, String>,
    },
    /// Result of a (non-force) push; `NeedsForce` opens a force-push confirm.
    PushDone {
        workspace_id: Uuid,
        repo_id: Uuid,
        repo_name: String,
        result: Result<PushResult, String>,
    },
    Toast(String),
}

#[derive(Clone)]
pub enum Health {
    Unknown,
    Ok,
    Err(String),
}

pub enum Loadable<T> {
    Loading,
    Ready(T),
    Failed(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Workspaces,
    Sessions,
}

/// Which pane of the Detail screen has keyboard focus. `↑↓`/`jk` act on the
/// focused pane; `⇥`/`←→` move between them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DetailFocus {
    Processes,
    Git,
    Transcript,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    List,
    Detail,
    Inbox,
    Create,
    Kanban,
}

/// Which field of the create-task form has focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CreateField {
    Name,
    Prompt,
    Repo,
    Branch,
    Executor,
}

/// State for the create-task form.
pub struct CreateForm {
    pub name: String,
    pub prompt: String,
    pub repos: Loadable<Vec<Repo>>,
    pub repo_idx: usize,
    pub branch: String,
    pub executor_idx: usize,
    pub field: CreateField,
    pub submitting: bool,
}

impl CreateForm {
    fn new() -> Self {
        Self {
            name: String::new(),
            prompt: String::new(),
            repos: Loadable::Loading,
            repo_idx: 0,
            // Empty until repos load; `submit_create` falls back to the selected
            // repo's default branch when this is blank.
            branch: String::new(),
            executor_idx: 0,
            field: CreateField::Prompt,
            submitting: false,
        }
    }

    pub fn executor(&self) -> &'static str {
        EXECUTORS
            .get(self.executor_idx)
            .copied()
            .unwrap_or("CLAUDE_CODE")
    }

    pub fn selected_repo(&self) -> Option<&Repo> {
        match &self.repos {
            Loadable::Ready(list) => list.get(self.repo_idx),
            _ => None,
        }
    }
}

/// Kanban board state: the selected project's columns (statuses) and cards
/// (issues), plus the workspaces linked to those cards.
pub struct KanbanView {
    pub projects: Vec<Project>,
    pub project_idx: usize,
    /// Visible columns, sorted by `sort_order`.
    pub statuses: Vec<ProjectStatus>,
    /// Cards grouped by `status_id`, each sorted by `sort_order`.
    pub issues_by_status: HashMap<Uuid, Vec<Issue>>,
    /// Workspaces linked to any card in the project.
    pub workspaces: Vec<RemoteWorkspace>,
    pub col_idx: usize,
    pub card_idx: usize,
    pub loading: bool,
    pub error: Option<String>,
    /// When launching a workspace from a card, the `(project_id, issue_id)` to
    /// link once the workspace is created.
    pub pending_link: Option<(Uuid, Uuid)>,
}

impl KanbanView {
    fn new() -> Self {
        Self {
            projects: Vec::new(),
            project_idx: 0,
            statuses: Vec::new(),
            issues_by_status: HashMap::new(),
            workspaces: Vec::new(),
            col_idx: 0,
            card_idx: 0,
            loading: true,
            error: None,
            pending_link: None,
        }
    }

    pub fn selected_project(&self) -> Option<&Project> {
        self.projects.get(self.project_idx)
    }

    pub fn current_status(&self) -> Option<&ProjectStatus> {
        self.statuses.get(self.col_idx)
    }

    /// Cards in the currently focused column.
    pub fn current_cards(&self) -> &[Issue] {
        self.current_status()
            .and_then(|s| self.issues_by_status.get(&s.id))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn cards_for(&self, status_id: Uuid) -> &[Issue] {
        self.issues_by_status
            .get(&status_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn selected_card(&self) -> Option<&Issue> {
        self.current_cards().get(self.card_idx)
    }

    /// Non-archived workspaces linked to a given card.
    pub fn workspaces_for(&self, issue_id: Uuid) -> Vec<&RemoteWorkspace> {
        self.workspaces
            .iter()
            .filter(|w| !w.archived && w.issue_id == Some(issue_id))
            .collect()
    }

    /// Keep the column/card cursors within bounds after data changes.
    fn clamp(&mut self) {
        if self.col_idx >= self.statuses.len() {
            self.col_idx = self.statuses.len().saturating_sub(1);
        }
        let n = self.current_cards().len();
        if self.card_idx >= n {
            self.card_idx = n.saturating_sub(1);
        }
    }

    /// Rebuild `issues_by_status` from a flat list of cards.
    fn set_issues(&mut self, issues: Vec<Issue>) {
        let mut map: HashMap<Uuid, Vec<Issue>> = HashMap::new();
        for issue in issues {
            map.entry(issue.status_id).or_default().push(issue);
        }
        for cards in map.values_mut() {
            cards.sort_by(|a, b| {
                a.sort_order
                    .partial_cmp(&b.sort_order)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
        self.issues_by_status = map;
    }
}

/// Which field of the card create/edit form has focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CardField {
    Title,
    Description,
    Status,
    Priority,
}

/// A destructive git operation that requires a confirm modal before running.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GitOp {
    Merge,
    Rebase,
    ForcePush,
}

impl GitOp {
    pub fn label(self) -> &'static str {
        match self {
            GitOp::Merge => "merge",
            GitOp::Rebase => "rebase",
            GitOp::ForcePush => "force-push",
        }
    }
}

/// Which field of the create-PR form has focus.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PrField {
    Title,
    Body,
}

/// A modal capturing input for an approval response.
pub enum Modal {
    /// Free-text reason for denying a tool approval.
    DenyReason {
        approval_id: String,
        execution_process_id: Uuid,
        buffer: String,
    },
    /// Loading the question options for a question approval.
    LoadingQuestion { approval_id: String },
    /// Answering a question approval by selecting option(s) per question.
    Answer {
        approval_id: String,
        execution_process_id: Uuid,
        questions: Vec<QuestionItem>,
        /// Selected option index per question.
        selected: Vec<usize>,
        /// Which question currently has focus.
        focus: usize,
    },
    /// Compose a follow-up message (or queue it) for a session.
    FollowUp {
        session_id: Uuid,
        executor: String,
        buffer: String,
        /// When true, queue after the current turn instead of sending now.
        queue: bool,
    },
    /// Create or edit a kanban card.
    CardForm {
        /// `None` = create; `Some(issue_id)` = edit that card.
        editing: Option<Uuid>,
        title: String,
        description: String,
        /// Index into `KanbanView.statuses`.
        status_idx: usize,
        /// Index into `PRIORITIES` (0 = none).
        priority_idx: usize,
        field: CardField,
    },
    /// Confirm deletion of a card.
    ConfirmDelete { issue_id: Uuid, label: String },
    /// Read-only detail view of a card.
    CardDetail { issue_id: Uuid },
    /// Confirm a destructive git op (merge / rebase / force-push) on a repo.
    ConfirmGit {
        op: GitOp,
        workspace_id: Uuid,
        repo_id: Uuid,
        repo_name: String,
        target: String,
    },
    /// Compose a pull request (title + optional body) for a repo.
    PrForm {
        workspace_id: Uuid,
        repo_id: Uuid,
        repo_name: String,
        target: String,
        title: String,
        body: String,
        field: PrField,
    },
}

/// State for the Detail screen: a session's processes + the live transcript of
/// one selected process.
pub struct Detail {
    pub session_id: Uuid,
    pub session_label: String,
    pub session_executor: Option<String>,
    pub generation: u64,
    pub processes: ProcessList,
    pub proc_selected: usize,
    pub procs_connected: bool,
    /// Which process's logs we're streaming.
    pub log_exec_id: Option<Uuid>,
    pub log_token: u64,
    pub conversation: Conversation,
    /// Transcript scroll cursor (line index); follow keeps it pinned to the end.
    pub cursor: usize,
    pub follow: bool,
    /// The workspace this session belongs to (the git pane operates on it).
    pub workspace_id: Uuid,
    /// The workspace branch, shown as `branch → target` in the git pane.
    pub workspace_branch: String,
    /// Per-repo git status for the workspace (one entry per repo).
    pub git: Vec<GitRepoStatus>,
    pub git_loading: bool,
    pub git_error: Option<String>,
    /// Diff stats + PR state for the workspace (from the summaries endpoint).
    pub summary: Option<WorkspaceSummary>,
    /// Index of the active repo in `git` (git actions target it).
    pub repo_selected: usize,
    /// Label of an in-flight git action, shown in the pane while it runs.
    pub git_busy: Option<String>,
    /// Which pane currently has keyboard focus.
    pub focus: DetailFocus,
    handles: Vec<JoinHandle<()>>,
}

impl Detail {
    fn abort(&mut self) {
        for h in self.handles.drain(..) {
            h.abort();
        }
    }

    /// The repo the git actions currently target.
    pub fn selected_repo(&self) -> Option<&GitRepoStatus> {
        self.git.get(self.repo_selected)
    }
}

#[cfg(test)]
impl Detail {
    /// Build a Detail with no live streams, for render tests.
    pub(crate) fn for_test(workspace_id: Uuid, git: Vec<GitRepoStatus>) -> Self {
        Detail {
            session_id: Uuid::nil(),
            session_label: "test-session".into(),
            session_executor: None,
            generation: 0,
            processes: ProcessList::new(),
            proc_selected: 0,
            procs_connected: false,
            log_exec_id: None,
            log_token: 0,
            conversation: Conversation::new(),
            cursor: 0,
            follow: true,
            workspace_id,
            workspace_branch: "vk/test".into(),
            git,
            git_loading: false,
            git_error: None,
            summary: None,
            repo_selected: 0,
            git_busy: None,
            focus: DetailFocus::Transcript,
            handles: Vec::new(),
        }
    }
}

pub struct App {
    pub running: bool,
    pub client: ApiClient,
    pub tx: UnboundedSender<AppEvent>,
    pub health: Health,
    pub ticks: u64,

    pub screen: Screen,

    pub workspaces: Loadable<Vec<Workspace>>,
    pub ws_selected: usize,
    pub sessions: Loadable<Vec<Session>>,
    pub sessions_for: Option<Uuid>,
    pub session_selected: usize,
    pub focus: Focus,

    pub detail: Option<Detail>,
    generation: u64,

    pub approvals: ApprovalInbox,
    pub approvals_connected: bool,
    pub approval_selected: usize,
    /// Screen to return to when leaving the inbox.
    return_screen: Screen,
    pub modal: Option<Modal>,

    pub create: Option<CreateForm>,
    pub kanban: Option<KanbanView>,
    pub show_help: bool,

    pub toast: Option<String>,
}

impl App {
    pub fn new(client: ApiClient, tx: UnboundedSender<AppEvent>) -> Self {
        Self {
            running: true,
            client,
            tx,
            health: Health::Unknown,
            ticks: 0,
            screen: Screen::List,
            workspaces: Loadable::Loading,
            ws_selected: 0,
            sessions: Loadable::Loading,
            sessions_for: None,
            session_selected: 0,
            focus: Focus::Workspaces,
            detail: None,
            generation: 0,
            approvals: ApprovalInbox::new(),
            approvals_connected: false,
            approval_selected: 0,
            return_screen: Screen::List,
            modal: None,
            create: None,
            kanban: None,
            show_help: false,
            toast: None,
        }
    }

    pub fn bootstrap(&mut self) {
        self.check_health();
        self.load_workspaces();
        self.start_approvals_stream();
    }

    pub fn update(&mut self, ev: AppEvent) {
        match ev {
            AppEvent::Key(k) => self.on_key(k),
            AppEvent::Resize => {}
            AppEvent::Tick => {
                self.ticks = self.ticks.wrapping_add(1);
                if self.ticks.is_multiple_of(20) {
                    self.check_health();
                }
            }
            AppEvent::Health(r) => {
                self.health = match r {
                    Ok(()) => Health::Ok,
                    Err(e) => Health::Err(e),
                };
            }
            AppEvent::Workspaces(r) => self.on_workspaces(r),
            AppEvent::Sessions {
                workspace_id,
                result,
            } => self.on_sessions(workspace_id, result),
            AppEvent::ProcStream { generation, event } => self.on_proc_stream(generation, event),
            AppEvent::LogStream {
                generation,
                log_token,
                event,
            } => self.on_log_stream(generation, log_token, event),
            AppEvent::ApprovalStream(event) => self.on_approval_stream(event),
            AppEvent::ReconnectApprovals => self.start_approvals_stream(),
            AppEvent::ApprovalResponded {
                approval_id,
                result,
            } => self.on_approval_responded(approval_id, result),
            AppEvent::QuestionOptions {
                approval_id,
                questions,
            } => self.on_question_options(approval_id, questions),
            AppEvent::Repos(r) => self.on_repos(r),
            AppEvent::Created(r) => self.on_created(r),
            AppEvent::Projects(r) => self.on_projects(r),
            AppEvent::KanbanStatuses { project_id, result } => {
                self.on_kanban_statuses(project_id, result)
            }
            AppEvent::KanbanIssues { project_id, result } => {
                self.on_kanban_issues(project_id, result)
            }
            AppEvent::KanbanWorkspaces { project_id, result } => {
                self.on_kanban_workspaces(project_id, result)
            }
            AppEvent::KanbanMutated(r) => self.on_kanban_mutated(r),
            AppEvent::WorkspaceLinked(r) => self.on_workspace_linked(r),
            AppEvent::GitStatus {
                workspace_id,
                result,
            } => self.on_git_status(workspace_id, result),
            AppEvent::GitSummary {
                workspace_id,
                result,
            } => self.on_git_summary(workspace_id, result),
            AppEvent::GitActionDone {
                workspace_id,
                result,
            } => self.on_git_action_done(workspace_id, result),
            AppEvent::PushDone {
                workspace_id,
                repo_id,
                repo_name,
                result,
            } => self.on_push_done(workspace_id, repo_id, repo_name, result),
            AppEvent::Toast(t) => self.toast = Some(t),
        }
    }

    // ---- list data ----

    fn on_workspaces(&mut self, r: Result<Vec<Workspace>, String>) {
        match r {
            Ok(list) => {
                if self.ws_selected >= list.len() {
                    self.ws_selected = list.len().saturating_sub(1);
                }
                self.workspaces = Loadable::Ready(list);
                self.refresh_sessions_for_selection();
            }
            Err(e) => self.workspaces = Loadable::Failed(e),
        }
    }

    fn on_sessions(&mut self, workspace_id: Uuid, result: Result<Vec<Session>, String>) {
        if self.sessions_for != Some(workspace_id) {
            return;
        }
        match result {
            Ok(list) => {
                if self.session_selected >= list.len() {
                    self.session_selected = list.len().saturating_sub(1);
                }
                self.sessions = Loadable::Ready(list);
            }
            Err(e) => self.sessions = Loadable::Failed(e),
        }
    }

    pub fn selected_workspace(&self) -> Option<&Workspace> {
        match &self.workspaces {
            Loadable::Ready(list) => list.get(self.ws_selected),
            _ => None,
        }
    }

    fn selected_session(&self) -> Option<&Session> {
        match &self.sessions {
            Loadable::Ready(list) => list.get(self.session_selected),
            _ => None,
        }
    }

    // ---- key handling ----

    fn on_key(&mut self, k: KeyEvent) {
        // Help overlay swallows the next key.
        if self.show_help {
            self.show_help = false;
            return;
        }
        // A modal swallows all input until dismissed.
        if self.modal.is_some() {
            self.on_key_modal(k);
            return;
        }
        // Global quit.
        if matches!(k.code, KeyCode::Char('q'))
            || (k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL))
        {
            self.running = false;
            return;
        }
        // Global help.
        if k.code == KeyCode::Char('?') {
            self.show_help = true;
            return;
        }
        // Global: open the approvals inbox (except while already there).
        // Skip in the create form where 'a' is text input.
        if k.code == KeyCode::Char('a')
            && self.screen != Screen::Inbox
            && self.screen != Screen::Create
        {
            self.open_inbox();
            return;
        }
        match self.screen {
            Screen::List => self.on_key_list(k),
            Screen::Detail => self.on_key_detail(k),
            Screen::Inbox => self.on_key_inbox(k),
            Screen::Create => self.on_key_create(k),
            Screen::Kanban => self.on_key_kanban(k),
        }
    }

    fn on_key_list(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Char('r') => self.load_workspaces(),
            KeyCode::Char('n') => self.open_create(),
            KeyCode::Char('b') => self.open_kanban(),
            KeyCode::Tab => self.toggle_focus(),
            KeyCode::Left | KeyCode::Char('h') => self.focus = Focus::Workspaces,
            KeyCode::Right | KeyCode::Char('l') => self.focus = Focus::Sessions,
            KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
            KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
            KeyCode::Enter => self.open_detail(),
            _ => {}
        }
    }

    fn on_key_detail(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc => self.close_detail(),
            // Move focus between the processes / git / transcript panes.
            KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => self.cycle_detail_focus(1),
            KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => self.cycle_detail_focus(-1),
            // ↑↓/jk act on the focused pane.
            KeyCode::Down | KeyCode::Char('j') => self.detail_nav(1),
            KeyCode::Up | KeyCode::Char('k') => self.detail_nav(-1),
            KeyCode::Char('G') => self.transcript_end(),
            KeyCode::Char('g') => self.transcript_top(),
            KeyCode::Char('i') => self.begin_followup(),
            KeyCode::Char('f') => {
                if let Some(d) = &mut self.detail {
                    d.follow = !d.follow;
                }
            }
            // Process shortcuts, available regardless of focus.
            KeyCode::Char('n') | KeyCode::Char(']') => self.cycle_process(1),
            KeyCode::Char('p') | KeyCode::Char('[') => self.cycle_process(-1),
            KeyCode::Char('s') => self.stop_selected_process(),
            // Git actions, available regardless of focus (target the selected repo).
            KeyCode::Char('m') => self.git_confirm(GitOp::Merge),
            KeyCode::Char('R') => self.git_confirm(GitOp::Rebase),
            KeyCode::Char('P') => self.open_pr_form(),
            KeyCode::Char('u') => self.do_push(),
            _ => {}
        }
    }

    /// Cycle the focused detail pane (processes → git → transcript → …).
    fn cycle_detail_focus(&mut self, delta: i32) {
        if let Some(d) = &mut self.detail {
            d.focus = next_detail_focus(d.focus, delta);
        }
    }

    /// Route ↑↓ to the focused pane: select a process, select a repo, or scroll.
    fn detail_nav(&mut self, delta: i32) {
        let Some(focus) = self.detail.as_ref().map(|d| d.focus) else {
            return;
        };
        match focus {
            DetailFocus::Processes => self.cycle_process(delta),
            DetailFocus::Git => self.cycle_repo(delta),
            DetailFocus::Transcript => self.scroll_transcript(delta),
        }
    }

    fn on_key_create(&mut self, k: KeyEvent) {
        // Ctrl+S submits from any field.
        if k.code == KeyCode::Char('s') && k.modifiers.contains(KeyModifiers::CONTROL) {
            self.submit_create();
            return;
        }
        let Some(form) = &mut self.create else { return };
        match k.code {
            KeyCode::Esc => {
                self.create = None;
                // If we got here from "run workspace on a card", drop the pending
                // link and return to the board instead of the workspace list.
                let from_card = self
                    .kanban
                    .as_mut()
                    .map(|k| k.pending_link.take().is_some())
                    .unwrap_or(false);
                self.screen = if from_card {
                    Screen::Kanban
                } else {
                    Screen::List
                };
            }
            KeyCode::Tab => form.field = next_field(form.field, 1),
            KeyCode::BackTab => form.field = next_field(form.field, -1),
            _ => match form.field {
                CreateField::Name => edit_text(&mut form.name, k.code),
                CreateField::Prompt => edit_text(&mut form.prompt, k.code),
                CreateField::Branch => edit_text(&mut form.branch, k.code),
                CreateField::Repo => {
                    // Snapshot len + per-repo default branches first to avoid
                    // borrowing `form.repos` while mutating other form fields.
                    let (len, defaults): (usize, Vec<Option<String>>) = match &form.repos {
                        Loadable::Ready(list) => (
                            list.len(),
                            list.iter()
                                .map(|r| r.default_target_branch.clone())
                                .collect(),
                        ),
                        _ => (0, Vec::new()),
                    };
                    if len > 0 {
                        let old = form.repo_idx;
                        match k.code {
                            KeyCode::Left | KeyCode::Char('h') => {
                                form.repo_idx = step(form.repo_idx, -1, len)
                            }
                            KeyCode::Right | KeyCode::Char('l') => {
                                form.repo_idx = step(form.repo_idx, 1, len)
                            }
                            _ => {}
                        }
                        // Cycling repos resets the branch to that repo's default.
                        if form.repo_idx != old
                            && let Some(Some(def)) = defaults.get(form.repo_idx)
                        {
                            form.branch = def.clone();
                        }
                    }
                }
                CreateField::Executor => match k.code {
                    KeyCode::Left | KeyCode::Char('h') => {
                        form.executor_idx = step(form.executor_idx, -1, EXECUTORS.len())
                    }
                    KeyCode::Right | KeyCode::Char('l') => {
                        form.executor_idx = step(form.executor_idx, 1, EXECUTORS.len())
                    }
                    _ => {}
                },
            },
        }
    }

    fn on_key_inbox(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc | KeyCode::Char('a') => self.close_inbox(),
            KeyCode::Down | KeyCode::Char('j') => {
                self.approval_selected = step(self.approval_selected, 1, self.approvals.len());
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.approval_selected = step(self.approval_selected, -1, self.approvals.len());
            }
            KeyCode::Char('y') => self.approve_selected(),
            KeyCode::Char('d') => self.begin_deny_selected(),
            KeyCode::Enter => self.begin_answer_selected(),
            _ => {}
        }
    }

    /// Route keys to the active modal.
    fn on_key_modal(&mut self, k: KeyEvent) {
        // Snapshot column count before borrowing `self.modal` (the card form's
        // status picker cycles within it).
        let status_count = self.kanban.as_ref().map_or(0, |kb| kb.statuses.len());
        let Some(modal) = &mut self.modal else { return };
        match modal {
            Modal::DenyReason { buffer, .. } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter => self.submit_deny(),
                KeyCode::Backspace => {
                    buffer.pop();
                }
                KeyCode::Char(c) => buffer.push(c),
                _ => {}
            },
            Modal::LoadingQuestion { .. } => {
                if k.code == KeyCode::Esc {
                    self.modal = None;
                }
            }
            Modal::Answer {
                questions,
                selected,
                focus,
                ..
            } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Up | KeyCode::Char('k') => {
                    *focus = step(*focus, -1, questions.len());
                }
                KeyCode::Down | KeyCode::Char('j') => {
                    *focus = step(*focus, 1, questions.len());
                }
                KeyCode::Left | KeyCode::Char('h') => {
                    if let (Some(q), Some(sel)) = (questions.get(*focus), selected.get_mut(*focus))
                    {
                        *sel = step(*sel, -1, q.options.len());
                    }
                }
                KeyCode::Right | KeyCode::Char('l') => {
                    if let (Some(q), Some(sel)) = (questions.get(*focus), selected.get_mut(*focus))
                    {
                        *sel = step(*sel, 1, q.options.len());
                    }
                }
                KeyCode::Enter => self.submit_answer(),
                _ => {}
            },
            Modal::FollowUp { buffer, queue, .. } => match k.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Tab => *queue = !*queue,
                KeyCode::Enter => self.submit_followup(),
                KeyCode::Backspace => {
                    buffer.pop();
                }
                KeyCode::Char(c) => buffer.push(c),
                _ => {}
            },
            Modal::CardForm {
                title,
                description,
                status_idx,
                priority_idx,
                field,
                ..
            } => {
                // Ctrl+S submits from any field.
                if k.code == KeyCode::Char('s') && k.modifiers.contains(KeyModifiers::CONTROL) {
                    self.submit_card_form();
                    return;
                }
                match k.code {
                    KeyCode::Esc => self.modal = None,
                    KeyCode::Tab => *field = next_card_field(*field, 1),
                    KeyCode::BackTab => *field = next_card_field(*field, -1),
                    _ => match field {
                        CardField::Title => edit_text(title, k.code),
                        CardField::Description => edit_text(description, k.code),
                        CardField::Status => match k.code {
                            KeyCode::Left | KeyCode::Char('h') => {
                                *status_idx = step(*status_idx, -1, status_count)
                            }
                            KeyCode::Right | KeyCode::Char('l') => {
                                *status_idx = step(*status_idx, 1, status_count)
                            }
                            _ => {}
                        },
                        CardField::Priority => match k.code {
                            KeyCode::Left | KeyCode::Char('h') => {
                                *priority_idx = step(*priority_idx, -1, PRIORITIES.len())
                            }
                            KeyCode::Right | KeyCode::Char('l') => {
                                *priority_idx = step(*priority_idx, 1, PRIORITIES.len())
                            }
                            _ => {}
                        },
                    },
                }
            }
            Modal::ConfirmDelete { .. } => match k.code {
                KeyCode::Char('y') | KeyCode::Enter => self.confirm_delete_card(),
                KeyCode::Esc | KeyCode::Char('n') => self.modal = None,
                _ => {}
            },
            Modal::CardDetail { .. } => match k.code {
                // Launch a workspace for this card (matches the in-modal hint).
                KeyCode::Char('w') => {
                    self.modal = None;
                    self.run_workspace_from_card();
                }
                KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => self.modal = None,
                _ => {}
            },
            Modal::ConfirmGit { .. } => match k.code {
                KeyCode::Char('y') | KeyCode::Enter => self.confirm_git(),
                KeyCode::Esc | KeyCode::Char('n') => self.modal = None,
                _ => {}
            },
            Modal::PrForm {
                title, body, field, ..
            } => {
                // Ctrl+S submits from any field.
                if k.code == KeyCode::Char('s') && k.modifiers.contains(KeyModifiers::CONTROL) {
                    self.submit_pr_form();
                    return;
                }
                match k.code {
                    KeyCode::Esc => self.modal = None,
                    KeyCode::Tab => *field = next_pr_field(*field, 1),
                    KeyCode::BackTab => *field = next_pr_field(*field, -1),
                    KeyCode::Enter => self.submit_pr_form(),
                    _ => match field {
                        PrField::Title => edit_text(title, k.code),
                        PrField::Body => edit_text(body, k.code),
                    },
                }
            }
        }
    }

    fn toggle_focus(&mut self) {
        self.focus = match self.focus {
            Focus::Workspaces => Focus::Sessions,
            Focus::Sessions => Focus::Workspaces,
        };
    }

    fn move_selection(&mut self, delta: i32) {
        match self.focus {
            Focus::Workspaces => {
                if let Loadable::Ready(list) = &self.workspaces {
                    let new = step(self.ws_selected, delta, list.len());
                    if new != self.ws_selected {
                        self.ws_selected = new;
                        self.refresh_sessions_for_selection();
                    }
                }
            }
            Focus::Sessions => {
                if let Loadable::Ready(list) = &self.sessions {
                    self.session_selected = step(self.session_selected, delta, list.len());
                }
            }
        }
    }

    fn refresh_sessions_for_selection(&mut self) {
        let Some(ws) = self.selected_workspace() else {
            self.sessions = Loadable::Ready(Vec::new());
            self.sessions_for = None;
            return;
        };
        let id = ws.id;
        if self.sessions_for == Some(id) {
            return;
        }
        self.sessions_for = Some(id);
        self.session_selected = 0;
        self.sessions = Loadable::Loading;
        self.load_sessions(id);
    }

    // ---- detail screen ----

    fn open_detail(&mut self) {
        let Some(session) = self.selected_session() else {
            return;
        };
        let session_id = session.id;
        let label = session.label();
        let session_executor = session.executor.clone();
        let workspace_id = session.workspace_id;
        // The session's workspace is the one selected in the list; grab its
        // branch for the `branch → target` display in the git pane.
        let workspace_branch = self
            .selected_workspace()
            .map(|w| w.branch.clone())
            .unwrap_or_default();

        // Tear down any previous detail and bump the generation.
        if let Some(mut d) = self.detail.take() {
            d.abort();
        }
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;

        let proc_handle = ws::spawn_stream(
            self.client.session_processes_ws(session_id),
            self.tx.clone(),
            move |event| AppEvent::ProcStream { generation, event },
        );

        self.detail = Some(Detail {
            session_id,
            session_label: label,
            session_executor,
            generation,
            processes: ProcessList::new(),
            proc_selected: 0,
            procs_connected: false,
            log_exec_id: None,
            log_token: 0,
            conversation: Conversation::new(),
            cursor: 0,
            follow: true,
            workspace_id,
            workspace_branch,
            git: Vec::new(),
            git_loading: true,
            git_error: None,
            summary: None,
            repo_selected: 0,
            git_busy: None,
            focus: DetailFocus::Transcript,
            handles: vec![proc_handle],
        });
        self.screen = Screen::Detail;
        self.load_git(workspace_id);
    }

    /// Fetch per-repo git status + the workspace diff/PR summary for the detail.
    fn load_git(&self, workspace_id: Uuid) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .git_status(workspace_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::GitStatus {
                workspace_id,
                result,
            });
        });
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .workspace_summary(workspace_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::GitSummary {
                workspace_id,
                result,
            });
        });
    }

    /// Re-fetch git status for the open detail (after a successful action).
    fn reload_git(&self) {
        if let Some(d) = &self.detail {
            self.load_git(d.workspace_id);
        }
    }

    fn on_git_status(&mut self, workspace_id: Uuid, result: Result<Vec<GitRepoStatus>, String>) {
        let Some(d) = &mut self.detail else { return };
        if d.workspace_id != workspace_id {
            return;
        }
        d.git_loading = false;
        match result {
            Ok(list) => {
                d.git = list;
                if d.repo_selected >= d.git.len() {
                    d.repo_selected = 0;
                }
                d.git_error = None;
            }
            Err(e) => d.git_error = Some(e),
        }
    }

    fn on_git_summary(
        &mut self,
        workspace_id: Uuid,
        result: Result<Option<WorkspaceSummary>, String>,
    ) {
        let Some(d) = &mut self.detail else { return };
        if d.workspace_id != workspace_id {
            return;
        }
        if let Ok(summary) = result {
            d.summary = summary;
        }
    }

    fn on_git_action_done(&mut self, workspace_id: Uuid, result: Result<String, String>) {
        if let Some(d) = &mut self.detail
            && d.workspace_id == workspace_id
        {
            d.git_busy = None;
        }
        match result {
            Ok(msg) => {
                self.toast = Some(msg);
                self.reload_git();
            }
            Err(e) => self.toast = Some(format!("git error: {e}")),
        }
    }

    fn on_push_done(
        &mut self,
        workspace_id: Uuid,
        repo_id: Uuid,
        repo_name: String,
        result: Result<PushResult, String>,
    ) {
        if let Some(d) = &mut self.detail
            && d.workspace_id == workspace_id
        {
            d.git_busy = None;
        }
        match result {
            Ok(PushResult::Pushed) => {
                self.toast = Some("pushed".into());
                self.reload_git();
            }
            Ok(PushResult::NeedsForce) => {
                // The remote rejected a fast-forward push; offer a force-push.
                self.modal = Some(Modal::ConfirmGit {
                    op: GitOp::ForcePush,
                    workspace_id,
                    repo_id,
                    repo_name,
                    target: String::new(),
                });
            }
            Ok(PushResult::Failed(msg)) => self.toast = Some(format!("push failed: {msg}")),
            Err(e) => self.toast = Some(format!("push error: {e}")),
        }
    }

    /// Cycle the active repo in the git pane.
    fn cycle_repo(&mut self, delta: i32) {
        let Some(d) = &mut self.detail else { return };
        if d.git.len() < 2 {
            return;
        }
        let n = d.git.len() as i32;
        d.repo_selected = (((d.repo_selected as i32 + delta) % n + n) % n) as usize;
    }

    /// Open a confirm modal for a destructive git op on the selected repo.
    fn git_confirm(&mut self, op: GitOp) {
        let Some(d) = &self.detail else { return };
        if d.git_busy.is_some() {
            return;
        }
        let Some(repo) = d.selected_repo() else {
            self.toast = Some("no repo for this workspace".into());
            return;
        };
        // Mirror the GUI guard: a direct merge into a remote target is rejected.
        if op == GitOp::Merge && repo.is_target_remote {
            self.toast = Some("target is a remote branch — create a PR instead".into());
            return;
        }
        self.modal = Some(Modal::ConfirmGit {
            op,
            workspace_id: d.workspace_id,
            repo_id: repo.repo_id,
            repo_name: repo.repo_name.clone(),
            target: repo.target_branch_name.clone(),
        });
    }

    /// Run the confirmed git op (merge / rebase / force-push).
    fn confirm_git(&mut self) {
        let Some(Modal::ConfirmGit {
            op,
            workspace_id,
            repo_id,
            ..
        }) = self.modal.take()
        else {
            return;
        };
        if let Some(d) = &mut self.detail {
            d.git_busy = Some(op.label().to_string());
        }
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = match op {
                GitOp::Merge => client
                    .merge_workspace(workspace_id, repo_id)
                    .await
                    .map(|_| "merged".to_string()),
                GitOp::Rebase => client
                    .rebase_workspace(workspace_id, repo_id)
                    .await
                    .map(|_| "rebased".to_string()),
                GitOp::ForcePush => client
                    .force_push_workspace(workspace_id, repo_id)
                    .await
                    .map(|_| "force-pushed".to_string()),
            }
            .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::GitActionDone {
                workspace_id,
                result,
            });
        });
    }

    /// Push the selected repo (no confirm; force-push is confirmed if required).
    fn do_push(&mut self) {
        let Some(d) = &mut self.detail else { return };
        if d.git_busy.is_some() {
            return;
        }
        let Some(repo) = d.git.get(d.repo_selected) else {
            self.toast = Some("no repo for this workspace".into());
            return;
        };
        let workspace_id = d.workspace_id;
        let repo_id = repo.repo_id;
        let repo_name = repo.repo_name.clone();
        d.git_busy = Some("push".into());
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .push_workspace(workspace_id, repo_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::PushDone {
                workspace_id,
                repo_id,
                repo_name,
                result,
            });
        });
    }

    /// Open the create-PR form for the selected repo.
    fn open_pr_form(&mut self) {
        let Some(d) = &self.detail else { return };
        if d.git_busy.is_some() {
            return;
        }
        let Some(repo) = d.selected_repo() else {
            self.toast = Some("no repo for this workspace".into());
            return;
        };
        self.modal = Some(Modal::PrForm {
            workspace_id: d.workspace_id,
            repo_id: repo.repo_id,
            repo_name: repo.repo_name.clone(),
            target: repo.target_branch_name.clone(),
            // Default the title to the branch name; the user can edit it.
            title: d.workspace_branch.clone(),
            body: String::new(),
            field: PrField::Title,
        });
    }

    /// Submit the create-PR form.
    fn submit_pr_form(&mut self) {
        let has_title =
            matches!(&self.modal, Some(Modal::PrForm { title, .. }) if !title.trim().is_empty());
        if !has_title {
            self.toast = Some("PR title is required".into());
            return;
        }
        let Some(Modal::PrForm {
            workspace_id,
            repo_id,
            target,
            title,
            body,
            ..
        }) = self.modal.take()
        else {
            return;
        };
        if let Some(d) = &mut self.detail {
            d.git_busy = Some("create PR".into());
        }
        let req = CreatePrRequest {
            title: title.trim().to_string(),
            body: Some(body.trim().to_string()).filter(|s| !s.is_empty()),
            target_branch: Some(target),
            draft: Some(false),
            repo_id,
            auto_generate_description: false,
        };
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .create_pr(workspace_id, &req)
                .await
                .map(|url| format!("PR created: {url}"))
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::GitActionDone {
                workspace_id,
                result,
            });
        });
    }

    fn close_detail(&mut self) {
        if let Some(mut d) = self.detail.take() {
            d.abort();
        }
        // Bump generation so any in-flight frames are ignored.
        self.generation = self.generation.wrapping_add(1);
        self.screen = Screen::List;
    }

    fn on_proc_stream(&mut self, generation: u64, event: StreamEvent) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.generation != generation {
            return;
        }
        match event {
            StreamEvent::Frame(Decoded::Ready) => detail.procs_connected = true,
            StreamEvent::Frame(Decoded::Patch(p)) => {
                if let Err(e) = detail.processes.apply(&p) {
                    tracing::warn!("proc patch apply failed: {e}");
                }
            }
            StreamEvent::Closed => detail.procs_connected = false,
            StreamEvent::Frame(_) => {}
        }
        // Once processes are known, ensure we're streaming logs for one.
        self.ensure_log_stream();
    }

    /// Pick a process to show logs for (most recent coding-agent, else most
    /// recent overall) and start its log stream if not already running.
    fn ensure_log_stream(&mut self) {
        let Some(detail) = &self.detail else { return };
        if detail.log_exec_id.is_some() {
            return;
        }
        let procs = detail.processes.processes();
        let target = procs
            .iter()
            .rev()
            .find(|p| p.run_reason == RunReason::CodingAgent)
            .or_else(|| procs.last())
            .map(|p| p.id);
        if let Some(exec_id) = target {
            // Set proc_selected to the chosen process for clarity.
            if let Some(idx) = procs.iter().position(|p| p.id == exec_id)
                && let Some(d) = &mut self.detail
            {
                d.proc_selected = idx;
            }
            self.start_log_stream(exec_id);
        }
    }

    fn start_log_stream(&mut self, exec_id: Uuid) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.log_exec_id == Some(exec_id) {
            return;
        }
        detail.log_exec_id = Some(exec_id);
        detail.log_token = detail.log_token.wrapping_add(1);
        detail.conversation = Conversation::new();
        detail.cursor = 0;
        detail.follow = true;
        let generation = detail.generation;
        let log_token = detail.log_token;

        let handle = ws::spawn_stream(
            self.client.normalized_logs_ws(exec_id),
            self.tx.clone(),
            move |event| AppEvent::LogStream {
                generation,
                log_token,
                event,
            },
        );
        detail.handles.push(handle);
    }

    fn on_log_stream(&mut self, generation: u64, log_token: u64, event: StreamEvent) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        if detail.generation != generation || detail.log_token != log_token {
            return;
        }
        if let StreamEvent::Frame(Decoded::Patch(p)) = event {
            if let Err(e) = detail.conversation.apply(&p) {
                tracing::warn!("log patch apply failed: {e}");
            }
            if detail.follow {
                let n = detail.conversation.lines().len();
                detail.cursor = n.saturating_sub(1);
            }
        }
    }

    fn cycle_process(&mut self, delta: i32) {
        let Some(detail) = &self.detail else { return };
        let procs = detail.processes.processes();
        if procs.is_empty() {
            return;
        }
        let new = step(detail.proc_selected, delta, procs.len());
        let exec_id = procs[new].id;
        if let Some(d) = &mut self.detail {
            d.proc_selected = new;
        }
        self.start_log_stream(exec_id);
    }

    fn scroll_transcript(&mut self, delta: i32) {
        let Some(detail) = &mut self.detail else {
            return;
        };
        let n = detail.conversation.lines().len();
        let new = step(detail.cursor, delta, n);
        detail.cursor = new;
        // Re-enable follow only when scrolled to the very end.
        detail.follow = n > 0 && new == n - 1;
    }

    fn transcript_top(&mut self) {
        if let Some(d) = &mut self.detail {
            d.cursor = 0;
            d.follow = false;
        }
    }

    fn transcript_end(&mut self) {
        if let Some(d) = &mut self.detail {
            d.cursor = d.conversation.lines().len().saturating_sub(1);
            d.follow = true;
        }
    }

    fn stop_selected_process(&mut self) {
        let Some(detail) = &self.detail else { return };
        let procs = detail.processes.processes();
        let Some(p) = procs.get(detail.proc_selected) else {
            return;
        };
        let exec_id = p.id;
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let msg = match client.stop_process(exec_id).await {
                Ok(()) => format!("stopped process {}", short(&exec_id)),
                Err(e) => format!("stop failed: {e}"),
            };
            let _ = tx.send(AppEvent::Toast(msg));
        });
    }

    // ---- follow-up / queue ----

    fn begin_followup(&mut self) {
        let Some(d) = &self.detail else { return };
        self.modal = Some(Modal::FollowUp {
            session_id: d.session_id,
            executor: d
                .session_executor
                .clone()
                .unwrap_or_else(|| "CLAUDE_CODE".to_string()),
            buffer: String::new(),
            queue: false,
        });
    }

    fn submit_followup(&mut self) {
        let Some(Modal::FollowUp {
            session_id,
            executor,
            buffer,
            queue,
        }) = self.modal.take()
        else {
            return;
        };
        let prompt = buffer.trim().to_string();
        if prompt.is_empty() {
            return;
        }
        let client = self.client.clone();
        let tx = self.tx.clone();
        let cfg = ExecutorConfigInput::new(executor);
        tokio::spawn(async move {
            let msg = if queue {
                match client
                    .queue_message(
                        session_id,
                        &QueueRequest {
                            message: prompt,
                            executor_config: cfg,
                        },
                    )
                    .await
                {
                    Ok(()) => "queued message".to_string(),
                    Err(e) => format!("queue failed: {e}"),
                }
            } else {
                match client
                    .follow_up(
                        session_id,
                        &FollowUpRequest {
                            prompt,
                            executor_config: cfg,
                        },
                    )
                    .await
                {
                    Ok(()) => "sent follow-up".to_string(),
                    Err(e) => format!("follow-up failed: {e}"),
                }
            };
            let _ = tx.send(AppEvent::Toast(msg));
        });
    }

    // ---- create task ----

    fn open_create(&mut self) {
        self.create = Some(CreateForm::new());
        self.screen = Screen::Create;
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client.list_repos().await.map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Repos(r));
        });
    }

    fn on_repos(&mut self, r: Result<Vec<Repo>, String>) {
        let Some(form) = &mut self.create else { return };
        match r {
            Ok(list) => {
                // Show the selected repo's default branch (the user can override).
                if form.branch.trim().is_empty()
                    && let Some(def) = list
                        .get(form.repo_idx)
                        .and_then(|repo| repo.default_target_branch.clone())
                {
                    form.branch = def;
                }
                form.repos = Loadable::Ready(list);
            }
            Err(e) => form.repos = Loadable::Failed(e),
        }
    }

    fn submit_create(&mut self) {
        let Some(form) = &mut self.create else { return };
        let Some(repo) = form.selected_repo() else {
            self.toast = Some("no repo selected (register one first)".into());
            return;
        };
        if form.prompt.trim().is_empty() {
            self.toast = Some("prompt is required".into());
            return;
        }
        let branch = if form.branch.trim().is_empty() {
            repo.default_target_branch
                .clone()
                .unwrap_or_else(|| "main".to_string())
        } else {
            form.branch.trim().to_string()
        };
        let req = CreateAndStartRequest {
            name: Some(form.name.trim().to_string()).filter(|s| !s.is_empty()),
            repos: vec![WorkspaceRepoInput {
                repo_id: repo.id,
                target_branch: branch,
            }],
            linked_issue: None,
            executor_config: ExecutorConfigInput::new(form.executor()),
            prompt: form.prompt.trim().to_string(),
            attachment_ids: None,
        };
        form.submitting = true;
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client
                .create_and_start(&req)
                .await
                .map(|resp| resp.workspace.id)
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Created(r));
        });
    }

    fn on_created(&mut self, r: Result<Uuid, String>) {
        match r {
            Ok(workspace_id) => {
                self.create = None;
                // If this workspace was launched from a kanban card, link it and
                // return to the board; otherwise behave like a normal new task.
                let pending = self.kanban.as_mut().and_then(|k| k.pending_link.take());
                if let Some((project_id, issue_id)) = pending {
                    self.screen = Screen::Kanban;
                    self.toast = Some("workspace started — linking to card…".into());
                    self.link_workspace(workspace_id, project_id, issue_id);
                } else {
                    self.screen = Screen::List;
                    self.toast = Some("task created — agent started".into());
                    self.load_workspaces();
                }
            }
            Err(e) => {
                if let Some(form) = &mut self.create {
                    form.submitting = false;
                }
                self.toast = Some(format!("create failed: {e}"));
            }
        }
    }

    // ---- kanban board ----

    fn on_key_kanban(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Esc => self.screen = Screen::List,
            KeyCode::Char('r') => {
                if let Some(pid) = self.kanban_project_id() {
                    self.load_board(pid);
                }
            }
            KeyCode::Char('p') => self.cycle_project(1),
            KeyCode::Left | KeyCode::Char('h') => self.move_column(-1),
            KeyCode::Right | KeyCode::Char('l') => self.move_column(1),
            KeyCode::Down | KeyCode::Char('j') => self.move_card_selection(1),
            KeyCode::Up | KeyCode::Char('k') => self.move_card_selection(-1),
            KeyCode::Char('n') => self.open_card_create(),
            KeyCode::Char('e') => self.open_card_edit(),
            KeyCode::Char('d') | KeyCode::Char('x') => self.begin_delete_card(),
            KeyCode::Char('[') => self.move_card_to_column(-1),
            KeyCode::Char(']') => self.move_card_to_column(1),
            KeyCode::Char('w') => self.run_workspace_from_card(),
            KeyCode::Enter => self.open_card_detail(),
            _ => {}
        }
    }

    fn open_kanban(&mut self) {
        self.kanban = Some(KanbanView::new());
        self.screen = Screen::Kanban;
        self.load_projects();
    }

    fn kanban_project_id(&self) -> Option<Uuid> {
        self.kanban
            .as_ref()
            .and_then(|k| k.selected_project())
            .map(|p| p.id)
    }

    fn load_projects(&mut self) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client.list_projects().await.map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Projects(r));
        });
    }

    fn on_projects(&mut self, r: Result<Vec<Project>, String>) {
        match r {
            Ok(list) => {
                let pid = list.first().map(|p| p.id);
                if let Some(k) = &mut self.kanban {
                    k.projects = list;
                    k.project_idx = 0;
                    k.error = None;
                    k.loading = pid.is_some();
                }
                if let Some(pid) = pid {
                    self.load_board(pid);
                }
            }
            Err(e) => {
                if let Some(k) = &mut self.kanban {
                    k.error = Some(e);
                    k.loading = false;
                }
            }
        }
    }

    /// Load a project's columns, cards, and linked workspaces in parallel.
    fn load_board(&mut self, project_id: Uuid) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .list_statuses(project_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::KanbanStatuses { project_id, result });
        });
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .list_issues(project_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::KanbanIssues { project_id, result });
        });
        self.load_project_workspaces(project_id);
    }

    fn load_project_workspaces(&self, project_id: Uuid) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .list_project_workspaces(project_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::KanbanWorkspaces { project_id, result });
        });
    }

    fn on_kanban_statuses(&mut self, project_id: Uuid, result: Result<Vec<ProjectStatus>, String>) {
        if self.kanban_project_id() != Some(project_id) {
            return;
        }
        let Some(k) = &mut self.kanban else { return };
        k.loading = false;
        match result {
            Ok(mut list) => {
                list.retain(|s| !s.hidden);
                list.sort_by_key(|s| s.sort_order);
                k.statuses = list;
                k.clamp();
            }
            Err(e) => k.error = Some(e),
        }
    }

    fn on_kanban_issues(&mut self, project_id: Uuid, result: Result<Vec<Issue>, String>) {
        if self.kanban_project_id() != Some(project_id) {
            return;
        }
        let Some(k) = &mut self.kanban else { return };
        match result {
            Ok(list) => {
                k.set_issues(list);
                k.clamp();
            }
            Err(e) => k.error = Some(e),
        }
    }

    fn on_kanban_workspaces(
        &mut self,
        project_id: Uuid,
        result: Result<Vec<RemoteWorkspace>, String>,
    ) {
        if self.kanban_project_id() != Some(project_id) {
            return;
        }
        if let (Some(k), Ok(list)) = (&mut self.kanban, result) {
            k.workspaces = list;
        }
    }

    fn cycle_project(&mut self, delta: i32) {
        let pid = {
            let Some(k) = &mut self.kanban else { return };
            if k.projects.len() < 2 {
                return;
            }
            let n = k.projects.len() as i32;
            k.project_idx = ((k.project_idx as i32 + delta).rem_euclid(n)) as usize;
            k.col_idx = 0;
            k.card_idx = 0;
            k.statuses.clear();
            k.issues_by_status.clear();
            k.workspaces.clear();
            k.loading = true;
            k.selected_project().map(|p| p.id)
        };
        if let Some(pid) = pid {
            self.load_board(pid);
        }
    }

    fn move_column(&mut self, delta: i32) {
        let Some(k) = &mut self.kanban else { return };
        k.col_idx = step(k.col_idx, delta, k.statuses.len());
        k.card_idx = 0;
    }

    fn move_card_selection(&mut self, delta: i32) {
        let Some(k) = &mut self.kanban else { return };
        let n = k.current_cards().len();
        k.card_idx = step(k.card_idx, delta, n);
    }

    fn open_card_create(&mut self) {
        let Some(k) = &self.kanban else { return };
        if k.statuses.is_empty() {
            self.toast = Some("this project has no columns".into());
            return;
        }
        let status_idx = k.col_idx;
        self.modal = Some(Modal::CardForm {
            editing: None,
            title: String::new(),
            description: String::new(),
            status_idx,
            priority_idx: 0,
            field: CardField::Title,
        });
    }

    fn open_card_edit(&mut self) {
        let Some(k) = &self.kanban else { return };
        let Some(card) = k.selected_card() else {
            return;
        };
        let status_idx = k
            .statuses
            .iter()
            .position(|s| s.id == card.status_id)
            .unwrap_or(k.col_idx);
        let priority_idx = card
            .priority
            .as_deref()
            .and_then(|p| PRIORITIES.iter().position(|x| *x == p))
            .unwrap_or(0);
        self.modal = Some(Modal::CardForm {
            editing: Some(card.id),
            title: card.title.clone(),
            description: card.description.clone().unwrap_or_default(),
            status_idx,
            priority_idx,
            field: CardField::Title,
        });
    }

    fn submit_card_form(&mut self) {
        // Validate without consuming the modal so it stays open on error.
        if let Some(Modal::CardForm { title, .. }) = &self.modal
            && title.trim().is_empty()
        {
            self.toast = Some("title is required".into());
            return;
        }
        let Some(Modal::CardForm {
            editing,
            title,
            description,
            status_idx,
            priority_idx,
            ..
        }) = self.modal.take()
        else {
            return;
        };

        let Some(k) = &self.kanban else { return };
        let Some(project) = k.selected_project() else {
            return;
        };
        let project_id = project.id;
        let Some(status) = k.statuses.get(status_idx) else {
            return;
        };
        let status_id = status.id;
        let title = title.trim().to_string();
        let description = Some(description.trim().to_string()).filter(|s| !s.is_empty());
        let priority = PRIORITIES
            .get(priority_idx)
            .filter(|p| **p != "none")
            .map(|p| p.to_string());

        let client = self.client.clone();
        let tx = self.tx.clone();
        if let Some(issue_id) = editing {
            let body = serde_json::json!({
                "title": title,
                "status_id": status_id,
                "description": description,
                "priority": priority,
            });
            tokio::spawn(async move {
                let r = client
                    .update_issue(issue_id, &body)
                    .await
                    .map(|_| "card updated".to_string())
                    .map_err(|e| e.to_string());
                let _ = tx.send(AppEvent::KanbanMutated(r));
            });
        } else {
            // New cards go to the top of their column.
            let min = k
                .cards_for(status_id)
                .iter()
                .map(|i| i.sort_order)
                .fold(f64::INFINITY, f64::min);
            let sort_order = if min.is_finite() { min - 1.0 } else { 0.0 };
            let req = CreateIssueRequest {
                project_id,
                status_id,
                title,
                description,
                priority,
                sort_order,
                extension_metadata: serde_json::json!({}),
            };
            tokio::spawn(async move {
                let r = client
                    .create_issue(&req)
                    .await
                    .map(|_| "card created".to_string())
                    .map_err(|e| e.to_string());
                let _ = tx.send(AppEvent::KanbanMutated(r));
            });
        }
    }

    fn begin_delete_card(&mut self) {
        let Some(k) = &self.kanban else { return };
        let Some(card) = k.selected_card() else {
            return;
        };
        let issue_id = card.id;
        let label = format!("{} {}", card.simple_id, card.title);
        self.modal = Some(Modal::ConfirmDelete { issue_id, label });
    }

    fn confirm_delete_card(&mut self) {
        let Some(Modal::ConfirmDelete { issue_id, .. }) = self.modal.take() else {
            return;
        };
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client
                .delete_issue(issue_id)
                .await
                .map(|_| "card deleted".to_string())
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::KanbanMutated(r));
        });
    }

    /// Move the selected card to the previous/next column (status change).
    fn move_card_to_column(&mut self, delta: i32) {
        let plan = {
            let Some(k) = &self.kanban else { return };
            let Some(card) = k.selected_card() else {
                return;
            };
            let target = k.col_idx as i32 + delta;
            if target < 0 || target as usize >= k.statuses.len() {
                return;
            }
            let target = target as usize;
            let target_status = k.statuses[target].id;
            let max = k
                .cards_for(target_status)
                .iter()
                .map(|i| i.sort_order)
                .fold(f64::NEG_INFINITY, f64::max);
            let sort_order = if max.is_finite() { max + 1.0 } else { 0.0 };
            (card.id, target, target_status, sort_order)
        };
        let (issue_id, target, target_status, sort_order) = plan;
        // Follow the card to its new column.
        if let Some(k) = &mut self.kanban {
            k.col_idx = target;
            k.card_idx = 0;
        }
        let body = serde_json::json!({ "status_id": target_status, "sort_order": sort_order });
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client
                .update_issue(issue_id, &body)
                .await
                .map(|_| "card moved".to_string())
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::KanbanMutated(r));
        });
    }

    fn open_card_detail(&mut self) {
        let Some(k) = &self.kanban else { return };
        let Some(card) = k.selected_card() else {
            return;
        };
        let issue_id = card.id;
        self.modal = Some(Modal::CardDetail { issue_id });
    }

    fn run_workspace_from_card(&mut self) {
        let plan = {
            let Some(k) = &self.kanban else { return };
            let Some(project) = k.selected_project() else {
                self.toast = Some("no project selected".into());
                return;
            };
            let Some(card) = k.selected_card() else {
                self.toast = Some("no card selected — pick one with ↑↓ first".into());
                return;
            };
            let prompt = match &card.description {
                Some(d) if !d.trim().is_empty() => format!("{}\n\n{}", card.title, d),
                _ => card.title.clone(),
            };
            (project.id, card.id, prompt)
        };
        let (project_id, issue_id, prompt) = plan;
        if let Some(k) = &mut self.kanban {
            k.pending_link = Some((project_id, issue_id));
        }
        let mut form = CreateForm::new();
        form.prompt = prompt;
        self.create = Some(form);
        self.screen = Screen::Create;
        // Load repos for the form (same as `open_create`).
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client.list_repos().await.map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Repos(r));
        });
    }

    fn link_workspace(&self, workspace_id: Uuid, project_id: Uuid, issue_id: Uuid) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client
                .link_workspace_to_issue(workspace_id, project_id, issue_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::WorkspaceLinked(r));
        });
    }

    fn on_kanban_mutated(&mut self, r: Result<String, String>) {
        match r {
            Ok(msg) => {
                self.toast = Some(msg);
                if let Some(pid) = self.kanban_project_id() {
                    let client = self.client.clone();
                    let tx = self.tx.clone();
                    tokio::spawn(async move {
                        let result = client.list_issues(pid).await.map_err(|e| e.to_string());
                        let _ = tx.send(AppEvent::KanbanIssues {
                            project_id: pid,
                            result,
                        });
                    });
                    self.load_project_workspaces(pid);
                }
            }
            Err(e) => self.toast = Some(format!("kanban error: {e}")),
        }
    }

    fn on_workspace_linked(&mut self, r: Result<(), String>) {
        match r {
            Ok(()) => {
                self.toast = Some("workspace linked to card".into());
                self.load_workspaces();
                if let Some(pid) = self.kanban_project_id() {
                    self.load_project_workspaces(pid);
                }
            }
            Err(e) => self.toast = Some(format!("link failed: {e}")),
        }
    }

    // ---- approvals inbox ----

    fn open_inbox(&mut self) {
        self.return_screen = self.screen;
        self.screen = Screen::Inbox;
        let n = self.approvals.len();
        if self.approval_selected >= n {
            self.approval_selected = n.saturating_sub(1);
        }
    }

    fn close_inbox(&mut self) {
        self.screen = self.return_screen;
    }

    fn selected_approval(&self) -> Option<crate::api::types::ApprovalInfo> {
        self.approvals
            .approvals()
            .into_iter()
            .nth(self.approval_selected)
    }

    fn on_approval_stream(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::Frame(Decoded::Ready) => self.approvals_connected = true,
            StreamEvent::Frame(Decoded::Patch(p)) => {
                let before = self.approvals.len();
                if let Err(e) = self.approvals.apply(&p) {
                    tracing::warn!("approval patch apply failed: {e}");
                }
                let n = self.approvals.len();
                if self.approval_selected >= n {
                    self.approval_selected = n.saturating_sub(1);
                }
                // Surface a newly-arrived approval if the user isn't already looking.
                if n > before && self.screen != Screen::Inbox {
                    self.toast = Some("🔔 new approval waiting — press a".to_string());
                }
            }
            StreamEvent::Closed => {
                self.approvals_connected = false;
                // Debounced reconnect so a downed backend doesn't spin.
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    let _ = tx.send(AppEvent::ReconnectApprovals);
                });
            }
            StreamEvent::Frame(_) => {}
        }
    }

    fn start_approvals_stream(&mut self) {
        let tx = self.tx.clone();
        ws::spawn_stream(self.client.approvals_ws(), tx, AppEvent::ApprovalStream);
    }

    fn approve_selected(&mut self) {
        let Some(info) = self.selected_approval() else {
            return;
        };
        if info.is_question {
            self.toast = Some("question approvals need an answer (press Enter)".into());
            return;
        }
        self.respond(
            info.approval_id,
            utils::approvals::ApprovalResponse {
                execution_process_id: info.execution_process_id,
                status: utils::approvals::ApprovalOutcome::Approved,
            },
        );
    }

    fn begin_deny_selected(&mut self) {
        let Some(info) = self.selected_approval() else {
            return;
        };
        if info.is_question {
            self.toast = Some("question approvals need an answer (press Enter)".into());
            return;
        }
        self.modal = Some(Modal::DenyReason {
            approval_id: info.approval_id,
            execution_process_id: info.execution_process_id,
            buffer: String::new(),
        });
    }

    fn submit_deny(&mut self) {
        let Some(Modal::DenyReason {
            approval_id,
            execution_process_id,
            buffer,
        }) = self.modal.take()
        else {
            return;
        };
        let reason = buffer.trim();
        let reason = if reason.is_empty() {
            None
        } else {
            Some(reason.to_string())
        };
        self.respond(
            approval_id,
            utils::approvals::ApprovalResponse {
                execution_process_id,
                status: utils::approvals::ApprovalOutcome::Denied { reason },
            },
        );
    }

    /// Begin answering a question approval: lazily fetch its options from the
    /// process transcript, then present a picker.
    fn begin_answer_selected(&mut self) {
        let Some(info) = self.selected_approval() else {
            return;
        };
        if !info.is_question {
            self.toast = Some("use y/d for tool approvals".into());
            return;
        }
        self.modal = Some(Modal::LoadingQuestion {
            approval_id: info.approval_id.clone(),
        });
        self.fetch_question_options(info.approval_id, info.execution_process_id);
    }

    fn on_question_options(&mut self, approval_id: String, questions: Vec<QuestionItem>) {
        // Only apply if we're still waiting for this approval's options.
        let still_loading = matches!(
            &self.modal,
            Some(Modal::LoadingQuestion { approval_id: a }) if *a == approval_id
        );
        if !still_loading {
            return;
        }
        if questions.is_empty() {
            self.modal = None;
            self.toast = Some("could not load question options".into());
            return;
        }
        let exec_id = self
            .approvals
            .approvals()
            .into_iter()
            .find(|a| a.approval_id == approval_id)
            .map(|a| a.execution_process_id);
        let Some(execution_process_id) = exec_id else {
            self.modal = None;
            return;
        };
        let selected = vec![0usize; questions.len()];
        self.modal = Some(Modal::Answer {
            approval_id,
            execution_process_id,
            questions,
            selected,
            focus: 0,
        });
    }

    fn submit_answer(&mut self) {
        let Some(Modal::Answer {
            approval_id,
            execution_process_id,
            questions,
            selected,
            ..
        }) = self.modal.take()
        else {
            return;
        };
        let answers = questions
            .iter()
            .zip(selected.iter())
            .map(|(q, &idx)| utils::approvals::QuestionAnswer {
                question: q.question.clone(),
                answer: q.options.get(idx).cloned().into_iter().collect(),
            })
            .collect();
        self.respond(
            approval_id,
            utils::approvals::ApprovalResponse {
                execution_process_id,
                status: utils::approvals::ApprovalOutcome::Answered { answers },
            },
        );
    }

    /// POST an approval response; the resolved patch will remove it from the
    /// stream. Reports the outcome via a toast.
    fn respond(&mut self, approval_id: String, body: utils::approvals::ApprovalResponse) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .respond_approval(&approval_id, &body)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::ApprovalResponded {
                approval_id,
                result,
            });
        });
    }

    fn on_approval_responded(&mut self, approval_id: String, result: Result<(), String>) {
        self.toast = Some(match result {
            Ok(()) => format!("responded to approval {}", short_str(&approval_id)),
            Err(e) => format!("approval response failed: {e}"),
        });
    }

    /// Open a short-lived log stream for `exec_id`, scan for the `AskUserQuestion`
    /// matching `approval_id`, and emit its options (or empty on timeout).
    fn fetch_question_options(&self, approval_id: String, exec_id: Uuid) {
        let ws_url = self.client.normalized_logs_ws(exec_id);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let questions = ws::scan_question_options(&ws_url, &approval_id).await;
            let _ = tx.send(AppEvent::QuestionOptions {
                approval_id,
                questions,
            });
        });
    }

    // ---- async commands ----

    fn check_health(&self) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client.health().await.map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Health(r));
        });
    }

    fn load_workspaces(&mut self) {
        self.workspaces = Loadable::Loading;
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let r = client.list_workspaces().await.map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Workspaces(r));
        });
    }

    fn load_sessions(&self, workspace_id: Uuid) {
        let client = self.client.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .list_sessions(workspace_id)
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(AppEvent::Sessions {
                workspace_id,
                result,
            });
        });
    }
}

/// Move `current` by `delta` within `[0, len)`, saturating at the ends.
pub(crate) fn step(current: usize, delta: i32, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let max = (len - 1) as i64;
    (current as i64 + delta as i64).clamp(0, max) as usize
}

/// First 8 chars of a UUID for compact display.
pub(crate) fn short(id: &Uuid) -> String {
    id.to_string().chars().take(8).collect()
}

/// Apply a basic text edit (char insert / backspace) to a buffer.
fn edit_text(buffer: &mut String, code: KeyCode) {
    match code {
        KeyCode::Char(c) => buffer.push(c),
        KeyCode::Backspace => {
            buffer.pop();
        }
        _ => {}
    }
}

/// Cycle the focused create-form field.
fn next_field(field: CreateField, delta: i32) -> CreateField {
    use CreateField::*;
    let order = [Name, Prompt, Repo, Branch, Executor];
    let idx = order.iter().position(|f| *f == field).unwrap_or(0);
    let n = order.len();
    let next = (idx as i32 + delta).rem_euclid(n as i32) as usize;
    order[next]
}

/// Cycle the focused card-form field.
fn next_card_field(field: CardField, delta: i32) -> CardField {
    use CardField::*;
    let order = [Title, Description, Status, Priority];
    let idx = order.iter().position(|f| *f == field).unwrap_or(0);
    let n = order.len();
    let next = (idx as i32 + delta).rem_euclid(n as i32) as usize;
    order[next]
}

/// Cycle the focused create-PR-form field.
fn next_pr_field(field: PrField, delta: i32) -> PrField {
    use PrField::*;
    let order = [Title, Body];
    let idx = order.iter().position(|f| *f == field).unwrap_or(0);
    let n = order.len();
    let next = (idx as i32 + delta).rem_euclid(n as i32) as usize;
    order[next]
}

/// Cycle the focused detail pane.
fn next_detail_focus(focus: DetailFocus, delta: i32) -> DetailFocus {
    use DetailFocus::*;
    let order = [Processes, Git, Transcript];
    let idx = order.iter().position(|f| *f == focus).unwrap_or(0);
    let n = order.len();
    let next = (idx as i32 + delta).rem_euclid(n as i32) as usize;
    order[next]
}

/// First 8 chars of an id string for compact display.
pub(crate) fn short_str(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Render-friendly view of an execution process.
pub fn process_label(p: &ExecutionProcess) -> String {
    let reason = match p.run_reason {
        RunReason::CodingAgent => "agent",
        RunReason::SetupScript => "setup",
        RunReason::CleanupScript => "cleanup",
        RunReason::ArchiveScript => "archive",
        RunReason::DevServer => "devserver",
    };
    format!("{reason} · {}", short(&p.id))
}
