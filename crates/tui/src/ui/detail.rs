//! The Detail screen: a session's execution processes (left) + the live
//! normalized-log transcript of the selected process (right).

use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line as TextLine, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
};

use crate::{
    api::types::{ProcStatus, WorkspaceSummary},
    app::{Detail, DetailFocus, process_label},
    state::conversation::{Line, ToolBadge},
};

/// Border colour for a pane: cyan when focused, dim grey otherwise.
fn border(focused: bool) -> Style {
    Style::default().fg(if focused {
        Color::Cyan
    } else {
        Color::DarkGray
    })
}

pub fn render(f: &mut Frame, detail: &Detail, area: Rect) {
    // processes · git pane (per-repo status + actions) · transcript.
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(24),
            Constraint::Length(34),
            Constraint::Min(20),
        ])
        .split(area);

    render_processes(f, detail, cols[0], detail.focus == DetailFocus::Processes);
    render_git(f, detail, cols[1], detail.focus == DetailFocus::Git);
    render_transcript(f, detail, cols[2], detail.focus == DetailFocus::Transcript);
}

/// The git pane: workspace diff/PR summary on top, then one block per repo
/// (branch → target, ahead/behind, conflict state), then the action hints.
fn render_git(f: &mut Frame, detail: &Detail, area: Rect, focused: bool) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border(focused))
        .title(" git ");

    if detail.git_loading && detail.git.is_empty() {
        f.render_widget(Paragraph::new("  loading…").dim().block(block), area);
        return;
    }
    if let Some(err) = &detail.git_error {
        f.render_widget(
            Paragraph::new(format!("  {err}"))
                .fg(Color::Red)
                .block(block)
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }

    let inner = block.inner(area);
    f.render_widget(block, area);

    let mut lines: Vec<TextLine> = Vec::new();

    // Workspace-level diff stats + PR state (from the summaries endpoint).
    if let Some(s) = &detail.summary {
        lines.push(TextLine::from(vec![
            Span::raw(format!("+{}", s.lines_added.unwrap_or(0))).fg(Color::Green),
            Span::raw(" "),
            Span::raw(format!("−{}", s.lines_removed.unwrap_or(0))).fg(Color::Red),
            Span::raw(format!("  ({} files)", s.files_changed.unwrap_or(0))).fg(Color::DarkGray),
        ]));
        if let Some(pr) = pr_line(s) {
            lines.push(pr);
        }
    } else {
        lines.push(TextLine::from("  diff stats unavailable").dim());
    }
    lines.push(TextLine::from(""));

    if detail.git.is_empty() {
        lines.push(TextLine::from("  no repos").dim());
    }
    for (i, r) in detail.git.iter().enumerate() {
        let active = i == detail.repo_selected;
        let marker = if active { "› " } else { "  " };
        let name_style = if active {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::Gray)
        };
        lines.push(TextLine::from(vec![
            Span::raw(marker).fg(Color::Cyan),
            Span::styled(r.repo_name.clone(), name_style),
        ]));
        lines.push(TextLine::from(vec![
            Span::raw("    "),
            Span::raw(detail.workspace_branch.clone()).fg(Color::Gray),
            Span::raw(" → ").fg(Color::DarkGray),
            Span::raw(r.target_branch_name.clone()).fg(Color::DarkGray),
        ]));
        let mut counts = vec![
            Span::raw("    "),
            Span::raw(format!("↑{}", r.commits_ahead.unwrap_or(0))).fg(Color::Green),
            Span::raw(" "),
            Span::raw(format!("↓{}", r.commits_behind.unwrap_or(0))).fg(Color::Yellow),
        ];
        if r.has_uncommitted_changes == Some(true) {
            counts.push(
                Span::raw(format!("  ●{}", r.uncommitted_count.unwrap_or(0))).fg(Color::Magenta),
            );
        }
        lines.push(TextLine::from(counts));
        if let Some(op) = &r.conflict_op {
            lines.push(TextLine::from(
                Span::raw(format!(
                    "    ⚠ {op} conflict ({})",
                    r.conflicted_files.len()
                ))
                .fg(Color::Red),
            ));
        } else if r.is_rebase_in_progress {
            lines.push(TextLine::from(
                Span::raw("    ⚠ rebase in progress").fg(Color::Red),
            ));
        }
        lines.push(TextLine::from(""));
    }

    if let Some(busy) = &detail.git_busy {
        lines.push(TextLine::from(
            Span::raw(format!("  … {busy}")).fg(Color::Yellow),
        ));
    }
    lines.push(TextLine::from("  m merge · R rebase").dim());
    lines.push(TextLine::from("  P pr · u push · ↑↓ repo").dim());

    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), inner);
}

/// A one-line PR badge for the git pane, or `None` when there is no PR.
fn pr_line(s: &WorkspaceSummary) -> Option<TextLine<'static>> {
    let status = s.pr_status.as_deref()?;
    if status.is_empty() || status == "none" {
        return None;
    }
    let num = s.pr_number.map(|n| format!("#{n} ")).unwrap_or_default();
    let color = match status {
        "open" => Color::Blue,
        "merged" => Color::Green,
        "closed" => Color::Red,
        _ => Color::Gray,
    };
    Some(TextLine::from(vec![
        Span::raw(format!("PR {num}")).fg(Color::Gray),
        Span::raw(status.to_string()).fg(color),
    ]))
}

fn render_processes(f: &mut Frame, detail: &Detail, area: Rect, focused: bool) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border(focused))
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

fn render_transcript(f: &mut Frame, detail: &Detail, area: Rect, focused: bool) {
    let follow = if detail.follow { "follow" } else { "scroll" };
    let title = format!(" {} — transcript [{}] ", detail.session_label, follow);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(border(focused))
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
