use std::{collections::HashMap, sync::Arc};

use api_types::LoginStatus;
use async_trait::async_trait;
use client_info::ClientInfo;
use db::DBService;
use deployment::{Deployment, DeploymentError};
use executors::profile::ExecutorConfigs;
use git::GitService;
use preview_proxy::PreviewProxyService;
use services::services::{
    approvals::Approvals,
    config::{Config, load_config_from_file, save_config_to_file},
    container::ContainerService,
    events::EventService,
    file::FileService,
    file_search::FileSearchCache,
    filesystem::FilesystemService,
    orchestrator_compactor::OrchestratorCompactor,
    pr_monitor::PrMonitorService,
    queued_message::QueuedMessageService,
    recurrent::scheduler::RecurrentScheduler,
    repo::RepoService,
};
use tokio::sync::{Notify, RwLock};
use tokio_util::sync::CancellationToken;
use utils::{assets::config_path, msg_store::MsgStore};
use workspace_manager::WorkspaceManager;
use worktree_manager::WorktreeManager;

use crate::{container::LocalContainerService, pty::PtyService};
mod command;
pub mod container;
mod copy;
pub mod pty;
pub mod terminal;

#[derive(Clone)]
pub struct LocalDeployment {
    config: Arc<RwLock<Config>>,
    db: DBService,
    workspace_manager: WorkspaceManager,
    container: LocalContainerService,
    git: GitService,
    repo: RepoService,
    file: FileService,
    filesystem: FilesystemService,
    events: EventService,
    file_search_cache: Arc<FileSearchCache>,
    approvals: Approvals,
    queued_message_service: QueuedMessageService,
    client_info: ClientInfo,
    preview_proxy: PreviewProxyService,
    pty: PtyService,
    pr_sync_notify: Arc<Notify>,
}

#[async_trait]
impl Deployment for LocalDeployment {
    async fn new(_shutdown: CancellationToken) -> Result<Self, DeploymentError> {
        // Run one-time process logs migration from DB to filesystem
        services::services::execution_process::migrate_execution_logs_to_files()
            .await
            .map_err(|e| DeploymentError::Other(anyhow::anyhow!("Migration failed: {}", e)))?;

        let mut raw_config = load_config_from_file(&config_path()).await;

        // Seed the bundled pipeline files on first run so the New Issue dialog
        // has pipelines to offer even before the operator customises them.
        if let Err(e) = services::services::pipelines::ensure_seeded(&utils::path::pipelines_dir())
        {
            tracing::warn!("failed to seed default pipelines: {}", e);
        }

        // Seed the bundled OpenCode subagent definitions (vk-sweeper/decider/
        // intake) into the opencode config so an opencode-headed orchestrator
        // can spawn them. Only seeds when opencode is already configured (its
        // config dir exists), to avoid creating config for non-opencode users.
        let opencode_config = utils::path::opencode_config_dir();
        if opencode_config.exists()
            && let Err(e) = services::services::opencode_agents::ensure_seeded(&opencode_config)
        {
            tracing::warn!("failed to seed opencode agents: {}", e);
        }

        let profiles = ExecutorConfigs::get_cached();
        if !raw_config.onboarding_acknowledged
            && let Ok(recommended_executor) = profiles.get_recommended_executor_profile().await
        {
            raw_config.executor_profile = recommended_executor;
        }

        // Track the running app version. The release-notes announcement was
        // removed, so ensure the (now-unused) flag can never stay stuck true in
        // existing configs.
        {
            let current_version = utils::version::APP_VERSION;
            if raw_config.last_app_version.as_deref() != Some(current_version) {
                raw_config.last_app_version = Some(current_version.to_string());
            }
            raw_config.show_release_notes = false;
        }

        // Always save config (may have been migrated or version updated)
        save_config_to_file(&raw_config, &config_path()).await?;

        if let Some(workspace_dir) = &raw_config.workspace_dir {
            let path = utils::path::expand_tilde(workspace_dir);
            WorktreeManager::set_workspace_dir_override(path);
        }

        let config = Arc::new(RwLock::new(raw_config));
        let git = GitService::new();
        let repo = RepoService::new();
        let msg_stores = Arc::new(RwLock::new(HashMap::new()));
        let filesystem = FilesystemService::new();

        // Create shared components for EventService
        let events_msg_store = Arc::new(MsgStore::new());
        let events_entry_count = Arc::new(RwLock::new(0));

        // Create DB with event hooks
        let db = {
            let hook = EventService::create_hook(
                events_msg_store.clone(),
                events_entry_count.clone(),
                DBService::new().await?, // Temporary DB service for the hook
            );
            DBService::new_with_after_connect(hook).await?
        };

        let file = FileService::new(db.clone().pool)?;
        {
            let file_service = file.clone();
            tokio::spawn(async move {
                tracing::info!("Starting orphaned file cleanup...");
                if let Err(e) = file_service.delete_orphaned_files().await {
                    tracing::error!("Failed to clean up orphaned files: {}", e);
                }
            });
        }

        let approvals = Approvals::new();
        let queued_message_service = QueuedMessageService::new();

        let client_info = ClientInfo::new();
        let preview_proxy = PreviewProxyService::new();

        let workspace_manager = WorkspaceManager::new(db.clone());
        let container = LocalContainerService::new(
            db.clone(),
            workspace_manager.clone(),
            msg_stores.clone(),
            config.clone(),
            git.clone(),
            file.clone(),
            approvals.clone(),
            queued_message_service.clone(),
        )
        .await;

        let events = EventService::new(db.clone(), events_msg_store, events_entry_count);

        let file_search_cache = Arc::new(FileSearchCache::new());

        let pty = PtyService::new();
        let pr_sync_notify = Arc::new(Notify::new());
        {
            let db = db.clone();
            let container = container.clone();
            PrMonitorService::spawn(db, container, pr_sync_notify.clone()).await;
        }
        {
            let db = db.clone();
            let container = container.clone();
            tracing::info!("Starting recurrent scheduler");
            RecurrentScheduler::spawn(db, container).await;
        }
        {
            let db = db.clone();
            let container = container.clone();
            tracing::info!("Starting orchestrator compactor");
            OrchestratorCompactor::spawn(db, container).await;
        }

        let deployment = Self {
            config,
            db,
            workspace_manager,
            container,
            git,
            repo,
            file,
            filesystem,
            events,
            file_search_cache,
            approvals,
            queued_message_service,
            client_info,
            preview_proxy,
            pty,
            pr_sync_notify,
        };

        Ok(deployment)
    }

    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn container(&self) -> &impl ContainerService {
        &self.container
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn repo(&self) -> &RepoService {
        &self.repo
    }

    fn file(&self) -> &FileService {
        &self.file
    }

    fn filesystem(&self) -> &FilesystemService {
        &self.filesystem
    }

    fn events(&self) -> &EventService {
        &self.events
    }

    fn file_search_cache(&self) -> &Arc<FileSearchCache> {
        &self.file_search_cache
    }

    fn approvals(&self) -> &Approvals {
        &self.approvals
    }

    fn queued_message_service(&self) -> &QueuedMessageService {
        &self.queued_message_service
    }

    fn client_info(&self) -> &ClientInfo {
        &self.client_info
    }

    fn preview_proxy(&self) -> &PreviewProxyService {
        &self.preview_proxy
    }
}

impl LocalDeployment {
    pub fn workspace_manager(&self) -> &WorkspaceManager {
        &self.workspace_manager
    }

    pub async fn get_login_status(&self) -> LoginStatus {
        // Local-only fork: no remote profile exists. Return LoggedOut so the
        // local UI prompts the user to keep using the local server.
        LoginStatus::LoggedOut
    }

    pub fn pty(&self) -> &PtyService {
        &self.pty
    }

    pub fn trigger_pr_sync(&self) {
        self.pr_sync_notify.notify_one();
    }
}
