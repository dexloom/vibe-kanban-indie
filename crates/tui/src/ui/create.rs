//! The create-task form: name, prompt, repo, target branch, and executor.
//! Submits `POST /api/workspaces/start` to create a workspace and start an agent.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::{
    api::types::EXECUTORS,
    app::{CreateField, CreateForm, Loadable},
};

pub fn render(f: &mut Frame, form: &CreateForm, area: Rect) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" new task — ⇥ next field · ←→ cycle · ^s create · esc cancel ");
    let inner = block.inner(area);
    f.render_widget(block, area);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2), // name
            Constraint::Length(2), // prompt
            Constraint::Length(2), // repo
            Constraint::Length(2), // branch
            Constraint::Length(2), // executor
            Constraint::Min(1),    // hint/status
        ])
        .split(inner);

    field(
        f,
        rows[0],
        "name",
        &form.name,
        form.field == CreateField::Name,
    );
    field(
        f,
        rows[1],
        "prompt*",
        &form.prompt,
        form.field == CreateField::Prompt,
    );
    repo_field(f, rows[2], form);
    field(
        f,
        rows[3],
        "branch",
        &form.branch,
        form.field == CreateField::Branch,
    );
    picker_field(
        f,
        rows[4],
        "executor",
        EXECUTORS.get(form.executor_idx).copied().unwrap_or(""),
        form.field == CreateField::Executor,
    );

    let status = if form.submitting {
        Span::raw("  creating…").fg(Color::Yellow)
    } else {
        Span::raw("  prompt is required; a repo must be registered to start an agent").dim()
    };
    f.render_widget(Paragraph::new(Line::from(status)), rows[5]);
}

fn label_span(label: &str, focused: bool) -> Span<'static> {
    let s = format!("{label:>9}: ");
    if focused {
        Span::raw(s).fg(Color::Cyan).add_modifier(Modifier::BOLD)
    } else {
        Span::raw(s).fg(Color::Gray)
    }
}

fn field(f: &mut Frame, area: Rect, label: &str, value: &str, focused: bool) {
    let cursor = if focused { "▏" } else { "" };
    let line = Line::from(vec![
        label_span(label, focused),
        Span::raw(value.to_string()),
        Span::raw(cursor).fg(Color::DarkGray),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn picker_field(f: &mut Frame, area: Rect, label: &str, value: &str, focused: bool) {
    let line = Line::from(vec![
        label_span(label, focused),
        Span::raw("◀ ").fg(Color::DarkGray),
        Span::raw(value.to_string())
            .fg(Color::White)
            .add_modifier(if focused {
                Modifier::REVERSED
            } else {
                Modifier::empty()
            }),
        Span::raw(" ▶").fg(Color::DarkGray),
    ]);
    f.render_widget(Paragraph::new(line), area);
}

fn repo_field(f: &mut Frame, area: Rect, form: &CreateForm) {
    let focused = form.field == CreateField::Repo;
    match &form.repos {
        Loadable::Loading => f.render_widget(
            Paragraph::new(Line::from(vec![
                label_span("repo", focused),
                Span::raw("loading…").dim(),
            ])),
            area,
        ),
        Loadable::Failed(e) => f.render_widget(
            Paragraph::new(Line::from(vec![
                label_span("repo", focused),
                Span::raw(format!("error: {e}")).fg(Color::Red),
            ])),
            area,
        ),
        Loadable::Ready(list) if list.is_empty() => f.render_widget(
            Paragraph::new(Line::from(vec![
                label_span("repo", focused),
                Span::raw("none registered — add one via the API/web first").fg(Color::Red),
            ])),
            area,
        ),
        Loadable::Ready(list) => {
            let name = list.get(form.repo_idx).map(|r| r.label()).unwrap_or("");
            let counter = format!("  ({}/{})", form.repo_idx + 1, list.len());
            let line = Line::from(vec![
                label_span("repo", focused),
                Span::raw("◀ ").fg(Color::DarkGray),
                Span::raw(name.to_string())
                    .fg(Color::White)
                    .add_modifier(if focused {
                        Modifier::REVERSED
                    } else {
                        Modifier::empty()
                    }),
                Span::raw(" ▶").fg(Color::DarkGray),
                Span::raw(counter).dim(),
            ]);
            f.render_widget(Paragraph::new(line), area);
        }
    }
}
