//! The default screen: workspaces (left) + sessions of the selected workspace
//! (right).

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
};

use crate::app::{App, Focus, Loadable};

pub fn render(f: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(area);

    render_workspaces(f, app, cols[0]);
    render_sessions(f, app, cols[1]);
}

fn render_workspaces(f: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == Focus::Workspaces;
    let block = pane_block(" workspaces ", focused);

    match &app.workspaces {
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
                Paragraph::new("  no workspaces yet").dim().block(block),
                area,
            );
        }
        Loadable::Ready(list) => {
            let items: Vec<ListItem> = list
                .iter()
                .map(|w| {
                    let mut spans = vec![Span::raw(w.label().to_string())];
                    if w.pinned {
                        spans.push(Span::raw(" 📌"));
                    }
                    if w.archived {
                        spans.push(Span::raw(" [archived]").fg(Color::DarkGray));
                    }
                    ListItem::new(Line::from(spans))
                })
                .collect();
            let mut state = ListState::default().with_selected(Some(app.ws_selected));
            f.render_stateful_widget(selectable_list(items, block, focused), area, &mut state);
        }
    }
}

fn render_sessions(f: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == Focus::Sessions;
    let block = pane_block(" sessions ", focused);

    match &app.sessions {
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
                Paragraph::new("  no sessions for this workspace")
                    .dim()
                    .block(block),
                area,
            );
        }
        Loadable::Ready(list) => {
            let items: Vec<ListItem> = list
                .iter()
                .map(|s| ListItem::new(Line::from(s.label())))
                .collect();
            let mut state = ListState::default().with_selected(Some(app.session_selected));
            f.render_stateful_widget(selectable_list(items, block, focused), area, &mut state);
        }
    }
}

pub(crate) fn pane_block(title: &str, focused: bool) -> Block<'_> {
    let border_color = if focused {
        Color::Cyan
    } else {
        Color::DarkGray
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .title(title)
}

pub(crate) fn selectable_list<'a>(
    items: Vec<ListItem<'a>>,
    block: Block<'a>,
    focused: bool,
) -> List<'a> {
    let highlight = if focused {
        Style::default()
            .bg(Color::Cyan)
            .fg(Color::Black)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().add_modifier(Modifier::REVERSED)
    };
    List::new(items)
        .block(block)
        .highlight_style(highlight)
        .highlight_symbol("› ")
}
