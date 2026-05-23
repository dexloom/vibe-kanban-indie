//! Pure render functions: `render(frame, &App)` draws the current state and
//! never mutates it. Top-level chrome (title bar + footer) lives here; each
//! screen renders into the middle region.

mod create;
mod detail;
mod inbox;
mod list;
mod modal;

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Stylize},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};

use crate::app::{App, Health, Screen};

pub fn render(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(f.area());

    render_title(f, app, chunks[0]);
    match app.screen {
        Screen::List => list::render(f, app, chunks[1]),
        Screen::Detail => {
            if let Some(d) = &app.detail {
                detail::render(f, d, chunks[1]);
            }
        }
        Screen::Inbox => inbox::render(f, app, chunks[1]),
        Screen::Create => {
            if let Some(form) = &app.create {
                create::render(f, form, chunks[1]);
            }
        }
    }
    render_footer(f, app, chunks[2]);

    // Modals overlay the whole content area.
    if let Some(m) = &app.modal {
        modal::render(f, m, chunks[1]);
    }
    if app.show_help {
        render_help(f, chunks[1]);
    }
}

fn render_help(f: &mut Frame, area: Rect) {
    use ratatui::widgets::Clear;
    let lines = vec![
        Line::from(" vibe-tui — keys ".bold()),
        Line::from(""),
        Line::from("  global    a  approvals inbox   ?  help   q  quit"),
        Line::from("  list      ↑↓/jk move · ⇥ pane · ⏎ open · n new task · r refresh"),
        Line::from(
            "  detail    ↑↓ scroll · n/p process · f follow · i message · s stop · esc back",
        ),
        Line::from("  inbox     ↑↓ move · y approve · d deny · ⏎ answer · esc back"),
        Line::from("  create    ⇥ field · ←→ cycle option · ^s create · esc cancel"),
        Line::from(""),
        Line::from("  press any key to close".to_string()).dim(),
    ];
    let w = 72.min(area.width);
    let h = (lines.len() as u16 + 2).min(area.height);
    let x = area.x + (area.width.saturating_sub(w)) / 2;
    let y = area.y + (area.height.saturating_sub(h)) / 2;
    let popup = Rect {
        x,
        y,
        width: w,
        height: h,
    };
    f.render_widget(Clear, popup);
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(ratatui::style::Style::default().fg(Color::Cyan))
                .title(" help "),
        ),
        popup,
    );
}

fn render_title(f: &mut Frame, app: &App, area: Rect) {
    let (status_text, status_color) = match &app.health {
        Health::Unknown => ("connecting…".to_string(), Color::Yellow),
        Health::Ok => ("● connected".to_string(), Color::Green),
        Health::Err(e) => (format!("● disconnected ({e})"), Color::Red),
    };
    let mut spans = vec![
        Span::raw("vibe-tui  "),
        Span::raw(app.client.base().to_string()).fg(Color::Cyan),
        Span::raw("  "),
        Span::raw(status_text).fg(status_color),
    ];
    // Pending-approval indicator (the "bell").
    let pending = app.approvals.len();
    if pending > 0 {
        spans.push(Span::raw("   "));
        spans.push(
            Span::raw(format!("🔔 {pending} waiting"))
                .fg(Color::Black)
                .bg(Color::Yellow)
                .bold(),
        );
    }
    let title = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::ALL)
            .title(" vibe-kanban "),
    );
    f.render_widget(title, area);
}

fn render_footer(f: &mut Frame, app: &App, area: Rect) {
    let mut spans = match app.screen {
        Screen::List => vec![
            key(" ↑↓/jk "),
            Span::raw(" move  "),
            key(" ⏎ "),
            Span::raw(" open  "),
            key(" n "),
            Span::raw(" new  "),
            key(" r "),
            Span::raw(" refresh  "),
        ],
        Screen::Detail => vec![
            key(" ↑↓/jk "),
            Span::raw(" scroll  "),
            key(" n/p "),
            Span::raw(" process  "),
            key(" i "),
            Span::raw(" message  "),
            key(" s "),
            Span::raw(" stop  "),
            key(" esc "),
            Span::raw(" back  "),
        ],
        Screen::Inbox => vec![
            key(" ↑↓/jk "),
            Span::raw(" move  "),
            key(" y "),
            Span::raw(" approve  "),
            key(" d "),
            Span::raw(" deny  "),
            key(" ⏎ "),
            Span::raw(" answer  "),
            key(" esc "),
            Span::raw(" back  "),
        ],
        Screen::Create => vec![
            key(" ⇥ "),
            Span::raw(" field  "),
            key(" ←→ "),
            Span::raw(" cycle  "),
            key(" ^s "),
            Span::raw(" create  "),
            key(" esc "),
            Span::raw(" cancel  "),
        ],
    };
    // Global approvals shortcut (except while already in the inbox).
    if app.screen != Screen::Inbox {
        spans.push(key(" a "));
        spans.push(Span::raw(format!(" approvals({})  ", app.approvals.len())));
    }
    spans.push(key(" q "));
    spans.push(Span::raw(" quit "));
    if let Some(t) = &app.toast {
        spans.push(Span::raw("   "));
        spans.push(Span::raw(t.clone()).fg(Color::Yellow));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn key(label: &str) -> Span<'static> {
    Span::raw(label.to_string())
        .bg(Color::DarkGray)
        .fg(Color::White)
}
