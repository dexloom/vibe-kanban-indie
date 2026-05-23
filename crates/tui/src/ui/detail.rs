//! The Detail screen: a session's execution processes (left) + the live
//! normalized-log transcript of the selected process (right).

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line as TextLine, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};

use crate::{
    api::types::ProcStatus,
    app::{Detail, process_label},
    state::conversation::{Line, ToolBadge},
};

pub fn render(f: &mut Frame, detail: &Detail, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(28), Constraint::Min(20)])
        .split(area);

    render_processes(f, detail, cols[0]);
    render_transcript(f, detail, cols[1]);
}

fn render_processes(f: &mut Frame, detail: &Detail, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(" processes ");

    let procs = detail.processes.processes();
    if procs.is_empty() {
        let msg = if detail.procs_connected {
            "  no processes yet"
        } else {
            "  connecting…"
        };
        f.render_widget(Paragraph::new(msg).dim().block(block), area);
        return;
    }

    let items: Vec<ListItem> = procs
        .iter()
        .map(|p| {
            let (glyph, color) = status_glyph(p.status);
            let mut spans = vec![
                Span::raw(glyph).fg(color),
                Span::raw(" "),
                Span::raw(process_label(p)),
            ];
            if p.dropped {
                spans.push(Span::raw(" ·dropped").fg(Color::DarkGray));
            }
            ListItem::new(TextLine::from(spans))
        })
        .collect();
    let mut state = ListState::default().with_selected(Some(detail.proc_selected));
    let list = List::new(items)
        .block(block)
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED))
        .highlight_symbol("› ");
    f.render_stateful_widget(list, area, &mut state);
}

fn render_transcript(f: &mut Frame, detail: &Detail, area: Rect) {
    let follow = if detail.follow { "follow" } else { "scroll" };
    let title = format!(" {} — transcript [{}] ", detail.session_label, follow);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(title);

    let lines = detail.conversation.lines();
    if lines.is_empty() {
        f.render_widget(
            Paragraph::new("  no agent output for this process")
                .dim()
                .block(block),
            area,
        );
        return;
    }

    let items: Vec<ListItem> = lines.iter().map(render_line).collect();
    let mut state = ListState::default().with_selected(Some(detail.cursor.min(items.len() - 1)));
    let list = List::new(items).block(block);
    f.render_stateful_widget(list, area, &mut state);
}

fn render_line(line: &Line) -> ListItem<'static> {
    let item = match line {
        Line::User(s) => labeled("you", Color::Green, s),
        Line::Assistant(s) => labeled("ai", Color::White, s),
        Line::Thinking(s) => labeled("…", Color::DarkGray, s),
        Line::System(s) => labeled("sys", Color::Blue, s),
        Line::Error(s) => labeled("err", Color::Red, s),
        Line::Stdout(s) => labeled("out", Color::DarkGray, s),
        Line::Stderr(s) => labeled("err", Color::Yellow, s),
        Line::Diff(s) => labeled("diff", Color::Magenta, s),
        Line::Other(s) => labeled("·", Color::DarkGray, s),
        Line::Tool {
            name,
            badge,
            summary,
            ..
        } => {
            let (glyph, color) = badge_glyph(*badge);
            TextLine::from(vec![
                Span::raw(glyph).fg(color),
                Span::raw(" "),
                Span::raw(name.clone()).fg(Color::Cyan),
                Span::raw("  "),
                Span::raw(one_line(summary)).fg(Color::Gray),
            ])
        }
    };
    ListItem::new(item)
}

fn labeled(tag: &'static str, color: Color, text: &str) -> TextLine<'static> {
    TextLine::from(vec![
        Span::raw(format!("{tag:>4} ")).fg(color).bold(),
        Span::raw(one_line(text)),
    ])
}

/// Collapse to a single line for the row-per-entry transcript (wrapping is T-M5).
fn one_line(s: &str) -> String {
    let collapsed = s.replace('\n', " ");
    collapsed.trim().to_string()
}

fn status_glyph(s: ProcStatus) -> (&'static str, Color) {
    match s {
        ProcStatus::Running => ("●", Color::Yellow),
        ProcStatus::Completed => ("✔", Color::Green),
        ProcStatus::Failed => ("✘", Color::Red),
        ProcStatus::Killed => ("■", Color::DarkGray),
    }
}

fn badge_glyph(b: ToolBadge) -> (&'static str, Color) {
    match b {
        ToolBadge::Created => ("⚙", Color::DarkGray),
        ToolBadge::Success => ("✔", Color::Green),
        ToolBadge::Failed => ("✘", Color::Red),
        ToolBadge::Denied => ("⊘", Color::Red),
        ToolBadge::PendingApproval => ("⏳", Color::Yellow),
        ToolBadge::TimedOut => ("⌛", Color::DarkGray),
        ToolBadge::Unknown => ("·", Color::DarkGray),
    }
}
