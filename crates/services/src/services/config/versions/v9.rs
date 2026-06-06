use anyhow::Error;
use executors::{
    executors::BaseCodingAgent, interactive::TerminalKind, profile::ExecutorProfileId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
// Re-export unchanged types from v8 so downstream code keeps a single import site.
pub use v8::{
    EditorConfig, EditorType, GitHubConfig, NotificationConfig, SendMessageShortcut, ShowcaseState,
    SoundFile, ThemeMode, UiLanguage,
};

use crate::services::config::versions::v8;

fn default_git_branch_prefix() -> String {
    "vk".to_string()
}

fn default_pr_auto_description_enabled() -> bool {
    true
}

fn default_commit_reminder_enabled() -> bool {
    true
}

fn default_relay_enabled() -> bool {
    true
}

/// Preferred terminal emulator used to attach to interactive (detached tmux)
/// agent sessions. Defaults to a platform-appropriate emulator.
fn default_terminal() -> TerminalKind {
    TerminalKind::platform_default()
}

/// Whether iTerm2 groups interactive agent sessions as tabs of a single VK
/// window (default) instead of opening a separate window per session.
fn default_iterm_tabs() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Config {
    pub config_version: String,
    pub theme: ThemeMode,
    pub executor_profile: ExecutorProfileId,
    pub disclaimer_acknowledged: bool,
    pub onboarding_acknowledged: bool,
    #[serde(default)]
    pub remote_onboarding_acknowledged: bool,
    pub notifications: NotificationConfig,
    pub editor: EditorConfig,
    pub github: GitHubConfig,
    pub analytics_enabled: bool,
    pub workspace_dir: Option<String>,
    pub last_app_version: Option<String>,
    pub show_release_notes: bool,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default = "default_git_branch_prefix")]
    pub git_branch_prefix: String,
    #[serde(default)]
    pub showcases: ShowcaseState,
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default = "default_commit_reminder_enabled")]
    pub commit_reminder_enabled: bool,
    #[serde(default)]
    pub commit_reminder_prompt: Option<String>,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default = "default_relay_enabled")]
    pub relay_enabled: bool,
    #[serde(default)]
    pub host_nickname: Option<String>,
    /// Terminal emulator used to attach to interactive agent sessions.
    #[serde(default = "default_terminal")]
    pub terminal: TerminalKind,
    /// When the terminal is iTerm2, group sessions as tabs of one window
    /// instead of opening a new window per session.
    #[serde(default = "default_iterm_tabs")]
    pub iterm_tabs: bool,
}

impl Config {
    fn from_v8_config(old_config: v8::Config) -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: old_config.theme,
            executor_profile: old_config.executor_profile,
            disclaimer_acknowledged: old_config.disclaimer_acknowledged,
            onboarding_acknowledged: old_config.onboarding_acknowledged,
            remote_onboarding_acknowledged: old_config.remote_onboarding_acknowledged,
            notifications: old_config.notifications,
            editor: old_config.editor,
            github: old_config.github,
            analytics_enabled: old_config.analytics_enabled,
            workspace_dir: old_config.workspace_dir,
            last_app_version: old_config.last_app_version,
            show_release_notes: old_config.show_release_notes,
            language: old_config.language,
            git_branch_prefix: old_config.git_branch_prefix,
            showcases: old_config.showcases,
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            commit_reminder_enabled: old_config.commit_reminder_enabled,
            commit_reminder_prompt: old_config.commit_reminder_prompt,
            send_message_shortcut: old_config.send_message_shortcut,
            relay_enabled: old_config.relay_enabled,
            host_nickname: old_config.host_nickname,
            terminal: default_terminal(),
            iterm_tabs: default_iterm_tabs(),
        }
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v8::Config::from(raw_config.to_string());
        Ok(Self::from_v8_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v9"
        {
            return config;
        }

        match Self::from_previous_version(&raw_config) {
            Ok(config) => {
                tracing::info!("Config upgraded to v9");
                config
            }
            Err(e) => {
                tracing::warn!("Config migration failed: {}, using default", e);
                Self::default()
            }
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: ThemeMode::System,
            executor_profile: ExecutorProfileId::new(BaseCodingAgent::ClaudeCode),
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            remote_onboarding_acknowledged: false,
            notifications: NotificationConfig::default(),
            editor: EditorConfig::default(),
            github: GitHubConfig::default(),
            analytics_enabled: true,
            workspace_dir: None,
            last_app_version: None,
            show_release_notes: false,
            language: UiLanguage::default(),
            git_branch_prefix: default_git_branch_prefix(),
            showcases: ShowcaseState::default(),
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            commit_reminder_enabled: true,
            commit_reminder_prompt: None,
            send_message_shortcut: SendMessageShortcut::default(),
            relay_enabled: true,
            host_nickname: None,
            terminal: default_terminal(),
            iterm_tabs: default_iterm_tabs(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v8_to_v9_with_default_terminal() {
        // A minimal v8 config blob (older versions migrate forward through v8).
        let v8_json = serde_json::json!({
            "config_version": "v8",
            "theme": "SYSTEM",
            "executor_profile": { "executor": "CLAUDE_CODE" },
            "disclaimer_acknowledged": true,
            "onboarding_acknowledged": true,
            "notifications": NotificationConfig::default(),
            "editor": EditorConfig::default(),
            "github": GitHubConfig::default(),
            "analytics_enabled": true,
            "workspace_dir": null,
            "last_app_version": null,
            "show_release_notes": false,
        })
        .to_string();

        let cfg = Config::from(v8_json);
        assert_eq!(cfg.config_version, "v9");
        assert_eq!(cfg.terminal, TerminalKind::platform_default());
    }

    #[test]
    fn v9_round_trips_terminal() {
        let cfg = Config {
            terminal: TerminalKind::WezTerm,
            ..Default::default()
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        let back = Config::from(raw);
        assert_eq!(back.terminal, TerminalKind::WezTerm);
        assert_eq!(back.config_version, "v9");
    }
}
