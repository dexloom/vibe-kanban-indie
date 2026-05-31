//! Centered popups for approval responses: deny-reason input and the
//! question-answer picker.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

use crate::{
    api::types::PRIORITIES,
    app::{App, CardField, GitOp, Modal, PrField},
};

pub fn render(f: &mut Frame, modal: &Modal, app: &App, area: Rect) {
    match modal {
        Modal::DenyReason { buffer, .. } => render_deny(f, buffer, area),
        Modal::LoadingQuestion { .. } => render_loading(f, area),
        Modal::Answer {
            questions,
            selected,
            focus,
            ..
        } => render_answer(f, questions, selected, *focus, area),
        Modal::FollowUp {
            buffer,
            queue,
            interactive,
            ..
        } => render_followup(f, buffer, *queue, *interactive, area),
        Modal::CardForm {
            editing,
            title,
            description,
            status_idx,
            priority_idx,
            field,
            ..
        } => render_card_form(
            f,
            editing.is_some(),
            title,
            description,
            *status_idx,
            *priority_idx,
            *field,
            app,
            area,
        ),
        Modal::ConfirmDelete { label, .. } => render_confirm_delete(f, label, area),
        Modal::CardDetail { issue_id } => render_card_detail(f, *issue_id, app, area),
        Modal::ConfirmGit {
            op,
            repo_name,
            target,
            ..
        } => render_confirm_git(f, *op, repo_name, target, area),
        Modal::PrForm {
            repo_name,
            target,
            title,
            body,
            field,
            ..
        } => render_pr_form(f, repo_name, target, title, body, *field, area),
    }
}

fn render_confirm_git(f: &mut Frame, op: GitOp, repo_name: &str, target: &str, area: Rect) {
    let (verb, color) = match op {
        GitOp::Merge => ("Merge", Color::Yellow),
        GitOp::Rebase => ("Rebase", Color::Yellow),
        GitOp::ForcePush => ("Force-push", Color::Red),
    };
    let detail = match op {
        GitOp::Merge => format!("merge {repo_name} into {target}"),
        GitOp::Rebase => format!("rebase {repo_name} onto {target}"),
        GitOp::ForcePush => format!("force-push {repo_name} to its remote"),
    };
    let popup = centered(62, 7, area);
    f.render_widget(Clear, popup);
    let body = vec![
        Line::from(vec![
            Span::raw(format!("{verb} ")),
            Span::raw(repo_name.to_string()).fg(Color::White).bold(),
            Span::raw("?"),
        ]),
        Line::from(Span::raw(detail).fg(Color::Gray)),
        Line::from(""),
        Line::from("  y confirm   ·   n / esc cancel").dim(),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(color))
        .title(format!(" {verb} "));
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_pr_form(
    f: &mut Frame,
    repo_name: &str,
    target: &str,
    title: &str,
    body: &str,
    field: PrField,
    area: Rect,
) {
    let popup = centered(72, 9, area);
    f.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" create PR — ⇥ field · ^s/⏎ submit · esc cancel ");
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1), // repo → target
            Constraint::Length(2), // title
            Constraint::Length(2), // body
            Constraint::Min(1),
        ])
        .split(inner);

    f.render_widget(
        Paragraph::new(Line::from(
            Span::raw(format!("{repo_name} → {target}")).fg(Color::Gray),
        )),
        rows[0],
    );
    text_field(f, rows[1], "title*", title, field == PrField::Title);
    text_field(f, rows[2], "body", body, field == PrField::Body);
}

#[allow(clippy::too_many_arguments)]
fn render_card_form(
    f: &mut Frame,
    editing: bool,
    title: &str,
    description: &str,
    status_idx: usize,
    priority_idx: usize,
    field: CardField,
    app: &App,
    area: Rect,
) {
    let popup = centered(72, 12, area);
    f.render_widget(Clear, popup);

    let status_name = app
        .kanban
        .as_ref()
        .and_then(|k| k.statuses.get(status_idx))
        .map(|s| s.name.as_str())
        .unwrap_or("—");
    let priority = PRIORITIES.get(priority_idx).copied().unwrap_or("none");

    let heading = if editing { " edit card " } else { " new card " };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(format!(
            "{heading}— ⇥ field · ←→ status/priority · ^s save · esc cancel"
        ));
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2), // title
            Constraint::Length(2), // description
            Constraint::Length(2), // status
            Constraint::Length(2), // priority
            Constraint::Min(1),
        ])
        .split(inner);

    text_field(f, rows[0], "title*", title, field == CardField::Title);
    text_field(
        f,
        rows[1],
        "description",
        description,
        field == CardField::Description,
    );
    picker_field(
        f,
        rows[2],
        "status",
        status_name,
        field == CardField::Status,
    );
    picker_field(
        f,
        rows[3],
        "priority",
        priority,
        field == CardField::Priority,
    );
}

fn render_confirm_delete(f: &mut Frame, label: &str, area: Rect) {
    let popup = centered(60, 6, area);
    f.render_widget(Clear, popup);
    let body = vec![
        Line::from(vec![
            Span::raw("Delete "),
            Span::raw(label.to_string()).fg(Color::White).bold(),
            Span::raw("?"),
        ]),
        Line::from(""),
        Line::from("  y delete   ·   n / esc cancel").dim(),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red))
        .title(" delete card ");
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_card_detail(f: &mut Frame, issue_id: uuid::Uuid, app: &App, area: Rect) {
    let popup = centered(72, 16, area);
    f.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" card — w new workspace · esc close ");
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let Some(k) = &app.kanban else { return };
    let Some(card) = k
        .issues_by_status
        .values()
        .flatten()
        .find(|c| c.id == issue_id)
    else {
        return;
    };

    let mut lines = vec![
        Line::from(vec![
            Span::raw(format!("{} ", card.simple_id)).fg(Color::DarkGray),
            Span::raw(card.title.clone()).bold(),
        ]),
        Line::from(vec![
            Span::raw("priority: ").fg(Color::Gray),
            Span::raw(card.priority.clone().unwrap_or_else(|| "none".into())),
        ]),
        Line::from(""),
        Line::from(
            card.description
                .clone()
                .unwrap_or_else(|| "(no description)".into()),
        ),
        Line::from(""),
    ];

    let workspaces = k.workspaces_for(card.id);
    lines.push(Line::from(format!("workspaces ({})", workspaces.len())).fg(Color::Cyan));
    if workspaces.is_empty() {
        lines.push(Line::from("  none yet").dim());
    } else {
        for w in workspaces {
            let name = w.name.clone().unwrap_or_else(|| "workspace".into());
            lines.push(Line::from(format!("  ⧉ {name}")));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from("  press w to create a workspace for this card").dim());

    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

fn text_field(f: &mut Frame, area: Rect, label: &str, value: &str, focused: bool) {
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

fn label_span(label: &str, focused: bool) -> Span<'static> {
    let s = format!("{label:>12}: ");
    if focused {
        Span::raw(s).fg(Color::Cyan).add_modifier(Modifier::BOLD)
    } else {
        Span::raw(s).fg(Color::Gray)
    }
}

fn render_followup(f: &mut Frame, buffer: &str, queue: bool, interactive: bool, area: Rect) {
    let popup = centered(70, 9, area);
    f.render_widget(Clear, popup);
    let (mode, color) = if queue {
        ("queue (after current turn)", Color::Yellow)
    } else {
        ("send now", Color::Green)
    };
    let (target, target_color) = if interactive {
        ("interactive terminal (tmux)", Color::Cyan)
    } else {
        ("headless", Color::Gray)
    };
    let body = vec![
        Line::from(vec![
            Span::raw("mode: ").fg(Color::Gray),
            Span::raw(mode).fg(color).bold(),
            Span::raw("   (⇥ toggle)").dim(),
        ]),
        Line::from(vec![
            Span::raw("run:  ").fg(Color::Gray),
            Span::raw(target).fg(target_color).bold(),
            Span::raw("   (^T toggle)").dim(),
        ]),
        Line::from(""),
        Line::from(vec![
            Span::raw("› ").fg(color),
            Span::raw(buffer.to_string()),
            Span::raw("▏").fg(Color::DarkGray),
        ]),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(color))
        .title(" message to agent — ⏎ submit · ⇥ mode · ^T terminal · esc cancel ");
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_deny(f: &mut Frame, buffer: &str, area: Rect) {
    let popup = centered(60, 7, area);
    f.render_widget(Clear, popup);
    let body = vec![
        Line::from("Reason for denial (optional):").fg(Color::Gray),
        Line::from(""),
        Line::from(vec![
            Span::raw("› ").fg(Color::Red),
            Span::raw(buffer.to_string()),
            Span::raw("▏").fg(Color::DarkGray),
        ]),
    ];
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Red))
        .title(" deny approval — ⏎ submit · esc cancel ");
    f.render_widget(
        Paragraph::new(body).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_loading(f: &mut Frame, area: Rect) {
    let popup = centered(40, 5, area);
    f.render_widget(Clear, popup);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Magenta))
        .title(" answer ");
    f.render_widget(
        Paragraph::new("\n  loading question options…")
            .dim()
            .block(block),
        popup,
    );
}

fn render_answer(
    f: &mut Frame,
    questions: &[crate::state::conversation::QuestionItem],
    selected: &[usize],
    focus: usize,
    area: Rect,
) {
    let height = (questions.len() as u16 * 3 + 4).min(area.height.saturating_sub(2));
    let popup = centered(70, height.max(7), area);
    f.render_widget(Clear, popup);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Magenta))
        .title(" answer question — ↑↓ question · ←→ option · ⏎ submit · esc cancel ");
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(
            questions
                .iter()
                .map(|_| Constraint::Length(3))
                .collect::<Vec<_>>(),
        )
        .split(inner);

    for (i, q) in questions.iter().enumerate() {
        let Some(row) = rows.get(i) else { break };
        let focused = i == focus;
        let sel = selected.get(i).copied().unwrap_or(0);
        let header = if focused {
            Span::raw(format!("▶ {}", q.header)).fg(Color::Cyan).bold()
        } else {
            Span::raw(format!("  {}", q.header)).fg(Color::Gray)
        };
        let chosen = q.options.get(sel).cloned().unwrap_or_default();
        let opts = Line::from(vec![
            Span::raw("    "),
            Span::raw("◀ ").fg(Color::DarkGray),
            Span::raw(chosen)
                .fg(Color::White)
                .add_modifier(Modifier::REVERSED),
            Span::raw(format!(" ▶  ({}/{})", sel + 1, q.options.len().max(1))).fg(Color::DarkGray),
        ]);
        f.render_widget(Paragraph::new(vec![Line::from(header), opts]), *row);
    }
}

/// A rect of the given width/height (in cells) centered within `area`.
fn centered(width: u16, height: u16, area: Rect) -> Rect {
    let w = width.min(area.width);
    let h = height.min(area.height);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    Rect {
        x,
        y,
        width: w,
        height: h,
    }
}
