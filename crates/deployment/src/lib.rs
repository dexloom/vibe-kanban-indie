use std::sync::Arc;

use anyhow::Error as AnyhowError;
use async_trait::async_trait;
use axum::response::sse::Event;
use client_info::ClientInfo;
use db::{DBService, models::workspace::WorkspaceError};
use executors::executors::ExecutorError;
use futures::{StreamExt, TryStreamExt};
use git::{GitService, GitServiceError};
use preview_proxy::PreviewProxyService;
use services::services::{
    approvals::Approvals,
    config::{Config, ConfigError},
    container::{ContainerError, ContainerService},
    events::{EventError, EventService},
    file::{FileError, FileService},
    file_search::FileSearchCache,
    filesystem::{FilesystemError, FilesystemService},
    filesystem_watcher::FilesystemWatcherError,
    queued_message::QueuedMessageService,
    repo::RepoService,
};
use sqlx::Error as SqlxError;
use thiserror::Error;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use worktree_manager::WorktreeError;

#[derive(Debug, Error)]
pub enum DeploymentError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    GitServiceError(#[from] GitServiceError),
    #[error(transparent)]
    FilesystemWatcherError(#[from] FilesystemWatcherError),
    #[error(transparent)]
    Workspace(#[from] WorkspaceError),
    #[error(transparent)]
    Container(#[from] ContainerError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
    #[error(transparent)]
    File(#[from] FileError),
    #[error(transparent)]
    Filesystem(#[from] FilesystemError),
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error(transparent)]
    Event(#[from] EventError),
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Other(#[from] AnyhowError),
}

#[async_trait]
pub trait Deployment: Clone + Send + Sync + 'static {
    async fn new(shutdown: CancellationToken) -> Result<Self, DeploymentError>;

    fn config(&self) -> &Arc<RwLock<Config>>;

    fn db(&self) -> &DBService;

    fn container(&self) -> &impl ContainerService;

    fn git(&self) -> &GitService;

    fn repo(&self) -> &RepoService;

    fn file(&self) -> &FileService;

    fn filesystem(&self) -> &FilesystemService;

    fn events(&self) -> &EventService;

    fn file_search_cache(&self) -> &Arc<FileSearchCache>;

    fn approvals(&self) -> &Approvals;

    fn queued_message_service(&self) -> &QueuedMessageService;

    fn client_info(&self) -> &ClientInfo;

    fn preview_proxy(&self) -> &PreviewProxyService;

    async fn stream_events(
        &self,
    ) -> futures::stream::BoxStream<'static, Result<Event, std::io::Error>> {
        self.events()
            .msg_store()
            .history_plus_stream()
            .map_ok(|m| m.to_sse_event())
            .boxed()
    }
}
