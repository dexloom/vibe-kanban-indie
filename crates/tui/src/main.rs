//! vibe-tui — a terminal cockpit for the vibe-kanban backend.
//!
//! Architecture: one render loop driven by a unified `AppEvent` mpsc. Background
//! tasks (terminal input, tick, and — in later milestones — WebSocket streams
//! and REST commands) push events; `App::update` reduces them; `ui::render`
//! draws. See `crates/tui` and the plan at
//! `~/.claude/plans/ethereal-crafting-lemon.md`.

mod api;
mod app;
mod event;
mod state;
mod ui;
mod ws;

#[cfg(test)]
mod tests;

use std::time::Duration;

use anyhow::Result;
use tokio::sync::mpsc;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

use crate::{
    api::ApiClient,
    app::{App, AppEvent},
};

#[tokio::main]
async fn main() -> Result<()> {
    // Logging goes to a file — the TUI owns the terminal, so stdout/stderr must
    // stay clean once the alternate screen is active.
    let _guard = init_logging();
    install_crypto_provider();

    // Resolve + connect before taking over the terminal, so connection errors
    // print normally to stderr instead of being swallowed by the alt-screen.
    let client = match ApiClient::connect().await {
        Ok(c) => {
            eprintln!("vibe-tui → backend {}", c.base());
            c
        }
        Err(e) => {
            eprintln!("vibe-tui: {e}");
            eprintln!("hint: start the backend (`cargo run -p server`) or set VIBE_BACKEND_URL.");
            std::process::exit(1);
        }
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<AppEvent>();
    event::spawn_input(tx.clone());
    event::spawn_ticker(tx.clone(), Duration::from_millis(250));

    let mut app = App::new(client, tx.clone());
    app.bootstrap();

    // `ratatui::init` enters the alternate screen, enables raw mode, and
    // installs a panic hook that restores the terminal on panic.
    let mut terminal = ratatui::init();
    let res = run(&mut terminal, &mut app, &mut rx).await;
    ratatui::restore();
    res
}

async fn run(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
    rx: &mut mpsc::UnboundedReceiver<AppEvent>,
) -> Result<()> {
    terminal.draw(|f| ui::render(f, app))?;
    while app.running {
        let Some(ev) = rx.recv().await else { break };
        app.update(ev);
        // Coalesce any immediately-available events before redrawing to avoid
        // render thrash under bursts (e.g. WS patch storms).
        while let Ok(ev) = rx.try_recv() {
            app.update(ev);
        }
        terminal.draw(|f| ui::render(f, app))?;
    }
    Ok(())
}

fn init_logging() -> WorkerGuard {
    let dir = std::env::var("VIBE_TUI_LOG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let file_appender = tracing_appender::rolling::never(&dir, "vibe-tui.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();
    guard
}

fn install_crypto_provider() {
    // Idempotent; needed before any rustls TLS handshake (WSS in later milestones).
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
