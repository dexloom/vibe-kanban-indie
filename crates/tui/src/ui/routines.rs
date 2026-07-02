//! The Routines screen: recurrent routines loaded from `/api/recurrent`
//! (name, schedule, enabled, last-run status). Failure visibility is a
//! per-row status color — routine failures are not surfaced in the
//! approvals Inbox (that's a dedicated approvals WS stream; not this).

use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Stylize},
    text::{Line, Span},
    widgets::{ListItem, ListState, Paragraph},
};

use super::list::{pane_block, selectable_list};
use crate::app::{App, Loadable};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    let block = pane_block(" routines ", true);

    match &app.routines {
        Loadable::Loading => {
            f.render_widget(Paragraph::new("  loading…").block(block), area);
        }
        Loadable::Failed(e) => {
            f.render_widget(
                Paragraph::new(format!("  error: {e}"))
                    .fg(Color::Red)
                    .block(block),
                area,
            );
        }
        Loadable::Ready(list) if list.is_empty() => {
            f.render_widget(
                Paragraph::new(
                    "  no routines configured (add a TOML file under ~/.vibe-kanban/recurrent/)",
                )
                .dim()
                .block(block),
                area,
            );
        }
        Loadable::Ready(list) => {
            let items: Vec<ListItem> = list.iter().map(routine_line).collect();
            let mut state = ListState::default().with_selected(Some(app.routine_selected));
            f.render_stateful_widget(selectable_list(items, block, true), area, &mut state);
        }
    }
}

fn routine_line(r: &crate::api::types::Routine) -> ListItem<'_> {
    let mut spans = Vec::new();
    if r.enabled {
        spans.push(Span::raw("● ").fg(Color::Green));
    } else {
        spans.push(Span::raw("○ ").fg(Color::DarkGray));
    }
    spans.push(Span::raw(r.name.clone()).bold());
    spans.push(Span::raw(format!("  · {}", r.schedule_label())).fg(Color::DarkGray));

    spans.push(Span::raw("  · "));
    spans.push(last_run_span(r));

    ListItem::new(Line::from(spans))
}

fn last_run_span(r: &crate::api::types::Routine) -> Span<'_> {
    match &r.last_run {
        None => Span::raw("never run").dim(),
        Some(last) => match last.status.as_str() {
            "completed" => Span::raw("completed").fg(Color::Green),
            "running" => Span::raw("running").fg(Color::Cyan),
            "failed" => Span::raw("failed").fg(Color::Red).bold(),
            "killed" => Span::raw("killed").fg(Color::Yellow),
            other => Span::raw(other.to_string()).dim(),
        },
    }
}
