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

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use tokio::{sync::mpsc::UnboundedSender, task::JoinHandle};
use uuid::Uuid;

use crate::{
    api::{
        ApiClient,
        types::{
            CreateAndStartRequest, EXECUTORS, ExecutionProcess, ExecutorConfigInput,
            FollowUpRequest, QueueRequest, Repo, RunReason, Session, Workspace, WorkspaceRepoInput,
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    List,
    Detail,
    Inbox,
    Create,
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
            branch: "main".to_string(),
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
    handles: Vec<JoinHandle<()>>,
}

impl Detail {
    fn abort(&mut self) {
        for h in self.handles.drain(..) {
            h.abort();
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
        }
    }

    fn on_key_list(&mut self, k: KeyEvent) {
        match k.code {
            KeyCode::Char('r') => self.load_workspaces(),
            KeyCode::Char('n') => self.open_create(),
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
            KeyCode::Esc | KeyCode::Left | KeyCode::Char('h') => self.close_detail(),
            KeyCode::Down | KeyCode::Char('j') => self.scroll_transcript(1),
            KeyCode::Up | KeyCode::Char('k') => self.scroll_transcript(-1),
            KeyCode::Char('G') => self.transcript_end(),
            KeyCode::Char('g') => self.transcript_top(),
            KeyCode::Char('i') => self.begin_followup(),
            KeyCode::Char('f') => {
                if let Some(d) = &mut self.detail {
                    d.follow = !d.follow;
                }
            }
            KeyCode::Char('n') | KeyCode::Char(']') => self.cycle_process(1),
            KeyCode::Char('p') | KeyCode::Char('[') => self.cycle_process(-1),
            KeyCode::Char('s') => self.stop_selected_process(),
            _ => {}
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
                self.screen = Screen::List;
            }
            KeyCode::Tab => form.field = next_field(form.field, 1),
            KeyCode::BackTab => form.field = next_field(form.field, -1),
            _ => match form.field {
                CreateField::Name => edit_text(&mut form.name, k.code),
                CreateField::Prompt => edit_text(&mut form.prompt, k.code),
                CreateField::Branch => edit_text(&mut form.branch, k.code),
                CreateField::Repo => {
                    if let Loadable::Ready(list) = &form.repos {
                        match k.code {
                            KeyCode::Left | KeyCode::Char('h') => {
                                form.repo_idx = step(form.repo_idx, -1, list.len())
                            }
                            KeyCode::Right | KeyCode::Char('l') => {
                                form.repo_idx = step(form.repo_idx, 1, list.len())
                            }
                            _ => {}
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
            handles: vec![proc_handle],
        });
        self.screen = Screen::Detail;
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
        form.repos = match r {
            Ok(list) => Loadable::Ready(list),
            Err(e) => Loadable::Failed(e),
        };
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
            Ok(_workspace_id) => {
                self.create = None;
                self.screen = Screen::List;
                self.toast = Some("task created — agent started".into());
                self.load_workspaces();
            }
            Err(e) => {
                if let Some(form) = &mut self.create {
                    form.submitting = false;
                }
                self.toast = Some(format!("create failed: {e}"));
            }
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
