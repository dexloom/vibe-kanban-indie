//! The kanban board: a project's columns (statuses) across the top, each a
//! list of cards (issues). Mirrors the web kanban for local projects — create,
//! edit, move, delete cards and launch a workspace from one.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Stylize},
    text::{Line, Span},
    widgets::{ListItem, ListState, Paragraph},
};

use super::list::{pane_block, selectable_list};
use crate::{api::types::Issue, app::KanbanView};

pub fn render(f: &mut Frame, k: &KanbanView, area: Rect) {
    if let Some(e) = &k.error {
        f.render_widget(Paragraph::new(format!("  error: {e}")).fg(Color::Red), area);
        return;
    }
    if k.projects.is_empty() {
        let msg = if k.loading {
            "  loading projects…"
        } else {
            "  no projects configured (create one in the web app, or import a config)"
        };
        f.render_widget(Paragraph::new(msg).dim(), area);
        return;
    }

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(area);

    render_header(f, k, rows[0]);

    if k.statuses.is_empty() {
        let msg = if k.loading {
            "  loading board…"
        } else {
            "  this project has no columns"
        };
        f.render_widget(Paragraph::new(msg).dim(), rows[1]);
        return;
    }
    render_columns(f, k, rows[1]);
}

fn render_header(f: &mut Frame, k: &KanbanView, area: Rect) {
    let name = k.selected_project().map(|p| p.name.as_str()).unwrap_or("");
    let mut spans = vec![
        Span::raw(" 📋 ").fg(Color::Cyan),
        Span::raw(name.to_string()).fg(Color::White).bold(),
    ];
    if k.projects.len() > 1 {
        spans.push(Span::raw(format!("  ({}/{})", k.project_idx + 1, k.projects.len())).dim());
        spans.push(Span::raw("  p switch").dim());
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_columns(f: &mut Frame, k: &KanbanView, area: Rect) {
    let n = k.statuses.len().max(1);
    let constraints: Vec<Constraint> = (0..n).map(|_| Constraint::Ratio(1, n as u32)).collect();
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(constraints)
        .split(area);

    for (i, status) in k.statuses.iter().enumerate() {
        let Some(col_area) = cols.get(i) else { break };
        let focused = i == k.col_idx;
        let cards = k.cards_for(status.id);
        let title = format!(" {} ({}) ", status.name, cards.len());
        let block = pane_block(&title, focused);

        if cards.is_empty() {
            f.render_widget(Paragraph::new("").block(block), *col_area);
            continue;
        }

        let items: Vec<ListItem> = cards.iter().map(|c| card_item(k, c)).collect();
        let mut state = ListState::default();
        if focused {
            state.select(Some(k.card_idx.min(cards.len().saturating_sub(1))));
        }
        f.render_stateful_widget(
            selectable_list(items, block, focused),
            *col_area,
            &mut state,
        );
    }
}

/// One card row: `SIMPLE-ID title  [priority] ⧉N`.
fn card_item<'a>(k: &KanbanView, card: &'a Issue) -> ListItem<'a> {
    let mut spans = vec![
        Span::raw(format!("{} ", card.simple_id)).fg(Color::DarkGray),
        Span::raw(card.title.clone()),
    ];
    if let Some(marker) = priority_marker(card.priority.as_deref()) {
        spans.push(Span::raw("  "));
        spans.push(marker);
    }
    let ws = k.workspaces_for(card.id).len();
    if ws > 0 {
        spans.push(Span::raw(format!("  ⧉{ws}")).fg(Color::Cyan));
    }
    ListItem::new(Line::from(spans))
}

/// Colored single-glyph priority marker, or `None` when unset.
fn priority_marker(priority: Option<&str>) -> Option<Span<'static>> {
    let (glyph, color) = match priority? {
        "urgent" => ("‼", Color::Red),
        "high" => ("↑", Color::LightRed),
        "medium" => ("•", Color::Yellow),
        "low" => ("↓", Color::Blue),
        _ => return None,
    };
    Some(Span::raw(glyph).fg(color).bold())
}
