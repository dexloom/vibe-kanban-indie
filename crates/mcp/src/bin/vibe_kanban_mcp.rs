use mcp::task_server::McpServer;
use rmcp::{ServiceExt, transport::stdio};
use tracing_subscriber::{EnvFilter, prelude::*};
use utils::{
    port_file::read_port_file,
    sentry::{self as sentry_utils, SentrySource, sentry_layer},
};

const HOST_ENV: &str = "MCP_HOST";
const PORT_ENV: &str = "MCP_PORT";

/// Env fallback for `--headed-local-control`. Truthy values (`1`/`true`/`yes`/
/// `on`, case-insensitive) enable the capability when the CLI flag is absent.
const HEADED_LOCAL_CONTROL_ENV: &str = "VIBE_HEADED_LOCAL_CONTROL";
/// Env fallback for `--mode`. Accepts `global` or `orchestrator` when `--mode`
/// is absent.
const MODE_ENV: &str = "VIBE_MCP_MODE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpLaunchMode {
    Global,
    Orchestrator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchConfig {
    mode: McpLaunchMode,
    /// Opt-in to the "headed local control" capability: surface Claude Code
    /// Headed direct-access identifiers (claude session id, tmux session name,
    /// transcript path) to the orchestrator. Off unless `--headed-local-control`
    /// is passed.
    headed_local_control: bool,
}

fn main() -> anyhow::Result<()> {
    let launch_config = resolve_launch_config()?;

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let version = env!("CARGO_PKG_VERSION");
            init_process_logging("vibe-kanban-mcp", version);

            let base_url = resolve_base_url("vibe-kanban-mcp").await?;
            let LaunchConfig {
                mode,
                headed_local_control,
            } = launch_config;

            let server = match mode {
                McpLaunchMode::Global => McpServer::new_global(&base_url, headed_local_control),
                McpLaunchMode::Orchestrator => {
                    McpServer::new_orchestrator(&base_url, headed_local_control)
                }
            };

            let service = server.init().await?.serve(stdio()).await.map_err(|error| {
                tracing::error!("serving error: {:?}", error);
                error
            })?;

            service.waiting().await?;
            Ok(())
        })
}

fn resolve_launch_config() -> anyhow::Result<LaunchConfig> {
    resolve_launch_config_from_iter(std::env::args().skip(1), |key| std::env::var(key).ok())
}

/// Interpret an env value as a boolean toggle. Truthy values are `1`, `true`,
/// `yes`, and `on` (case-insensitive); anything else — including an unset or
/// empty value — is false.
fn env_flag_is_truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Resolve the launch configuration from CLI args, falling back to env vars.
///
/// Precedence mirrors `resolve_base_url`: an explicit CLI flag/arg wins, the
/// env var is the fallback, and the built-in default is used last. `env` is
/// injected so tests can drive it without mutating the process environment.
fn resolve_launch_config_from_iter<I, F>(mut args: I, env: F) -> anyhow::Result<LaunchConfig>
where
    I: Iterator<Item = String>,
    F: Fn(&str) -> Option<String>,
{
    let mut mode = None;
    let mut headed_local_control_flag = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => {
                mode = Some(args.next().ok_or_else(|| {
                    anyhow::anyhow!("Missing value for --mode. Expected 'global' or 'orchestrator'")
                })?);
            }
            "--headed-local-control" => {
                headed_local_control_flag = true;
            }
            "-h" | "--help" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            _ => {
                return Err(anyhow::anyhow!("Unknown argument '{arg}'. {}", usage()));
            }
        }
    }

    // CLI flag wins; env var (truthy) is the fallback; default is off.
    let headed_local_control =
        headed_local_control_flag || env_flag_is_truthy(env(HEADED_LOCAL_CONTROL_ENV).as_deref());

    // CLI `--mode` wins; `VIBE_MCP_MODE` env is the fallback; default is global.
    let mode_value = mode.or_else(|| env(MODE_ENV));
    let mode = match mode_value
        .as_deref()
        .unwrap_or("global")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "global" => McpLaunchMode::Global,
        "orchestrator" => McpLaunchMode::Orchestrator,
        value => {
            return Err(anyhow::anyhow!(
                "Invalid MCP mode '{value}'. Expected 'global' or 'orchestrator'"
            ));
        }
    };

    Ok(LaunchConfig {
        mode,
        headed_local_control,
    })
}

fn usage() -> String {
    format!(
        "Usage: vibe-kanban-mcp --mode <global|orchestrator> [--headed-local-control]\n\
         Env fallbacks (CLI flag/arg takes precedence):\n  \
         {MODE_ENV}=<global|orchestrator>  (fallback for --mode)\n  \
         {HEADED_LOCAL_CONTROL_ENV}=<1|true|yes|on>  (fallback for --headed-local-control; case-insensitive, anything else is off)"
    )
}

async fn resolve_base_url(log_prefix: &str) -> anyhow::Result<String> {
    if let Ok(url) = std::env::var("VIBE_BACKEND_URL") {
        tracing::info!(
            "[{}] Using backend URL from VIBE_BACKEND_URL: {}",
            log_prefix,
            url
        );
        return Ok(url);
    }

    let host = std::env::var(HOST_ENV)
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let port = match std::env::var(PORT_ENV)
        .or_else(|_| std::env::var("BACKEND_PORT"))
        .or_else(|_| std::env::var("PORT"))
    {
        Ok(port_str) => {
            tracing::info!("[{}] Using port from environment: {}", log_prefix, port_str);
            port_str
                .parse::<u16>()
                .map_err(|error| anyhow::anyhow!("Invalid port value '{}': {}", port_str, error))?
        }
        Err(_) => {
            let port = read_port_file("vibe-kanban").await?;
            tracing::info!("[{}] Using port from port file: {}", log_prefix, port);
            port
        }
    };

    let url = format!("http://{}:{}", host, port);
    tracing::info!("[{}] Using backend URL: {}", log_prefix, url);
    Ok(url)
}

fn init_process_logging(log_prefix: &str, version: &str) {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    sentry_utils::init_once(SentrySource::Mcp);

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(EnvFilter::new("debug")),
        )
        .with(sentry_layer())
        .init();

    tracing::debug!(
        "[{}] Starting Vibe Kanban MCP server version {}...",
        log_prefix,
        version
    );
}

#[cfg(test)]
mod tests {
    use super::{
        HEADED_LOCAL_CONTROL_ENV, LaunchConfig, MODE_ENV, McpLaunchMode, env_flag_is_truthy,
        resolve_launch_config_from_iter,
    };

    /// Env lookup that always returns nothing (no env fallback).
    fn no_env(_key: &str) -> Option<String> {
        None
    }

    /// Env lookup backed by a fixed list of key/value pairs.
    fn env_map(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn orchestrator_mode_does_not_require_session_id() {
        let config = resolve_launch_config_from_iter(
            ["--mode".to_string(), "orchestrator".to_string()].into_iter(),
            no_env,
        )
        .expect("config should parse");

        assert_eq!(
            config,
            LaunchConfig {
                mode: McpLaunchMode::Orchestrator,
                headed_local_control: false,
            }
        );
    }

    #[test]
    fn headed_local_control_flag_is_parsed() {
        let config = resolve_launch_config_from_iter(
            [
                "--mode".to_string(),
                "orchestrator".to_string(),
                "--headed-local-control".to_string(),
            ]
            .into_iter(),
            no_env,
        )
        .expect("config should parse");

        assert_eq!(
            config,
            LaunchConfig {
                mode: McpLaunchMode::Orchestrator,
                headed_local_control: true,
            }
        );
    }

    #[test]
    fn headed_local_control_defaults_off() {
        let config = resolve_launch_config_from_iter(
            ["--mode".to_string(), "global".to_string()].into_iter(),
            no_env,
        )
        .expect("config should parse");

        assert!(!config.headed_local_control);
    }

    #[test]
    fn session_id_flag_is_rejected() {
        let error = resolve_launch_config_from_iter(
            [
                "--mode".to_string(),
                "orchestrator".to_string(),
                "--session-id".to_string(),
                "x".to_string(),
            ]
            .into_iter(),
            no_env,
        )
        .expect_err("session id flag should be rejected");

        assert!(
            error
                .to_string()
                .contains("Unknown argument '--session-id'")
        );
    }

    #[test]
    fn headed_local_control_env_enables_without_flag() {
        let config = resolve_launch_config_from_iter(
            std::iter::empty(),
            env_map(&[(HEADED_LOCAL_CONTROL_ENV, "true")]),
        )
        .expect("config should parse");

        assert!(config.headed_local_control);
        assert_eq!(config.mode, McpLaunchMode::Global);
    }

    #[test]
    fn headed_local_control_flag_wins_over_unset_env() {
        let config = resolve_launch_config_from_iter(
            ["--headed-local-control".to_string()].into_iter(),
            no_env,
        )
        .expect("config should parse");

        assert!(config.headed_local_control);
    }

    #[test]
    fn headed_local_control_flag_wins_over_falsey_env() {
        let config = resolve_launch_config_from_iter(
            ["--headed-local-control".to_string()].into_iter(),
            env_map(&[(HEADED_LOCAL_CONTROL_ENV, "0")]),
        )
        .expect("config should parse");

        assert!(config.headed_local_control);
    }

    #[test]
    fn headed_local_control_neither_set_defaults_off() {
        let config =
            resolve_launch_config_from_iter(std::iter::empty(), no_env).expect("config parses");

        assert!(!config.headed_local_control);
    }

    #[test]
    fn truthy_env_values_are_parsed_case_insensitively() {
        for value in ["1", "true", "TRUE", "Yes", "on", "ON"] {
            assert!(env_flag_is_truthy(Some(value)), "{value} should be truthy");
        }
        for value in ["0", "false", "no", "off", "", "  ", "enabled"] {
            assert!(
                !env_flag_is_truthy(Some(value)),
                "{value:?} should be falsey"
            );
        }
        assert!(!env_flag_is_truthy(None));
    }

    #[test]
    fn mode_env_selects_orchestrator_without_flag() {
        let config = resolve_launch_config_from_iter(
            std::iter::empty(),
            env_map(&[(MODE_ENV, "orchestrator")]),
        )
        .expect("config should parse");

        assert_eq!(config.mode, McpLaunchMode::Orchestrator);
    }

    #[test]
    fn mode_flag_overrides_mode_env() {
        let config = resolve_launch_config_from_iter(
            ["--mode".to_string(), "global".to_string()].into_iter(),
            env_map(&[(MODE_ENV, "orchestrator")]),
        )
        .expect("config should parse");

        assert_eq!(config.mode, McpLaunchMode::Global);
    }

    #[test]
    fn invalid_mode_env_is_rejected() {
        let error =
            resolve_launch_config_from_iter(std::iter::empty(), env_map(&[(MODE_ENV, "bogus")]))
                .expect_err("invalid mode env should error");

        assert!(error.to_string().contains("Invalid MCP mode 'bogus'"));
    }
}
