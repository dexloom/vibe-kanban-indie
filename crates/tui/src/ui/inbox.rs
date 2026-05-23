//! The approvals inbox: agents currently blocked waiting for a decision.
//! Approve (`y`) / deny (`d`) tool permissions, or answer (`⏎`) a question.

use chrono::{DateTime, Utc};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};

use crate::app::{App, short};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" approvals inbox ");

    let approvals = app.approvals.approvals();
    if approvals.is_empty() {
        let msg = if app.approvals_connected {
            "  no pending approvals — all agents are unblocked"
        } else {
            "  connecting…"
        };
        f.render_widget(Paragraph::new(msg).dim().block(block), area);
        return;
    }

    let now = Utc::now();
    let items: Vec<ListItem> = approvals
        .iter()
        .map(|a| {
            let mut spans = Vec::new();
            if a.is_question {
                spans.push(Span::raw("[?] ").fg(Color::Magenta).bold());
            } else {
                spans.push(Span::raw("[!] ").fg(Color::Yellow).bold());
            }
            spans.push(Span::raw(a.tool_name.clone()).fg(Color::White).bold());
            spans.push(
                Span::raw(format!("  · exec {}", short(&a.execution_process_id)))
                    .fg(Color::DarkGray),
            );
            spans.push(
                Span::raw(format!("  · {} ago", humanize(now - a.created_at))).fg(Color::Gray),
            );
            let (left, color) = time_left(a.timeout_at, now);
            spans.push(Span::raw(format!("  · ⌛ {left}")).fg(color));
            ListItem::new(Line::from(spans))
        })
        .collect();

    let mut state = ListState::default().with_selected(Some(app.approval_selected));
    let list = List::new(items)
        .block(block)
        .highlight_style(
            Style::default()
                .bg(Color::Cyan)
                .fg(Color::Black)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ");
    f.render_stateful_widget(list, area, &mut state);
}

fn humanize(d: chrono::Duration) -> String {
    let s = d.num_seconds().max(0);
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else {
        format!("{}h", s / 3600)
    }
}

fn time_left(timeout_at: DateTime<Utc>, now: DateTime<Utc>) -> (String, Color) {
    let remaining = timeout_at - now;
    let secs = remaining.num_seconds();
    if secs <= 0 {
        ("expired".to_string(), Color::Red)
    } else {
        let color = if secs < 120 {
            Color::Red
        } else {
            Color::DarkGray
        };
        (humanize(remaining), color)
    }
}
