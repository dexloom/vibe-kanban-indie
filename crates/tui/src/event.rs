//! Background producers that feed the unified `AppEvent` channel: terminal
//! input (via crossterm's async `EventStream`) and a periodic tick.

use std::time::Duration;

use crossterm::event::{Event, EventStream, KeyEventKind};
use futures_util::StreamExt;
use tokio::sync::mpsc::UnboundedSender;

use crate::app::AppEvent;

/// Forward key presses and resizes from the terminal into the app channel.
pub fn spawn_input(tx: UnboundedSender<AppEvent>) {
    tokio::spawn(async move {
        let mut stream = EventStream::new();
        while let Some(Ok(ev)) = stream.next().await {
            let app_ev = match ev {
                // Filter to Press so Windows' press+release pairs don't double-fire.
                Event::Key(k) if k.kind == KeyEventKind::Press => Some(AppEvent::Key(k)),
                Event::Resize(_, _) => Some(AppEvent::Resize),
                _ => None,
            };
            if let Some(e) = app_ev
                && tx.send(e).is_err()
            {
                break;
            }
        }
    });
}

/// Emit `AppEvent::Tick` on a fixed cadence.
pub fn spawn_ticker(tx: UnboundedSender<AppEvent>, period: Duration) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(period);
        loop {
            interval.tick().await;
            if tx.send(AppEvent::Tick).is_err() {
                break;
            }
        }
    });
}
