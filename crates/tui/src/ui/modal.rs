//! Centered popups for approval responses: deny-reason input and the
//! question-answer picker.

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

use crate::app::Modal;

pub fn render(f: &mut Frame, modal: &Modal, area: Rect) {
    match modal {
        Modal::DenyReason { buffer, .. } => render_deny(f, buffer, area),
        Modal::LoadingQuestion { .. } => render_loading(f, area),
        Modal::Answer {
            questions,
            selected,
            focus,
            ..
        } => render_answer(f, questions, selected, *focus, area),
        Modal::FollowUp { buffer, queue, .. } => render_followup(f, buffer, *queue, area),
    }
}

fn render_followup(f: &mut Frame, buffer: &str, queue: bool, area: Rect) {
    let popup = centered(70, 8, area);
    f.render_widget(Clear, popup);
    let (mode, color) = if queue {
        ("queue (after current turn)", Color::Yellow)
    } else {
        ("send now", Color::Green)
    };
    let body = vec![
        Line::from(vec![
            Span::raw("mode: ").fg(Color::Gray),
            Span::raw(mode).fg(color).bold(),
            Span::raw("   (⇥ toggle)").dim(),
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
        .title(" message to agent — ⏎ submit · ⇥ mode · esc cancel ");
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
