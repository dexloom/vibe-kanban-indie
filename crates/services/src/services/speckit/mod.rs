//! SpecKit (Spec-Driven Development) service logic.
//!
//! This module owns the *pure* pieces of the SpecKit workbench:
//! - mapping a [`SpecKitStage`] to its slash command, artifact, and agent prompt
//! - deriving a feature slug / feature dir from an issue
//! - parsing `tasks.md` into structured tasks + parallel-execution layers
//! - toggling a task's checkbox in `tasks.md`
//! - provisioning the `.specify/` scaffold into a repo worktree
//!
//! Filesystem-touching helpers are kept thin; the route layer
//! (`server::routes::speckit`) handles workspace resolution and agent runs.

use std::{
    io,
    path::{Path, PathBuf},
};

use api_types::speckit::{SpecKitStage, SpecKitTask, SpecKitTaskLayer, SpecKitTasks};
use utils::text::git_branch_id;

// ---------------------------------------------------------------------------
// Stage metadata
// ---------------------------------------------------------------------------

/// The Claude Code slash command that drives a stage.
pub fn slash_command(stage: SpecKitStage) -> &'static str {
    match stage {
        SpecKitStage::Constitution => "/speckit.constitution",
        SpecKitStage::Specify => "/speckit.specify",
        SpecKitStage::Clarify => "/speckit.clarify",
        SpecKitStage::Plan => "/speckit.plan",
        SpecKitStage::Tasks => "/speckit.tasks",
        SpecKitStage::Analyze => "/speckit.analyze",
        SpecKitStage::Implement => "/speckit.implement",
    }
}

/// The primary artifact a stage produces, relative to the feature dir.
///
/// `None` for stages that don't write a single canonical feature file:
/// `constitution` is repo-level, `analyze` produces findings, and `implement`
/// edits source + the task checkboxes rather than one artifact.
pub fn primary_artifact(stage: SpecKitStage) -> Option<&'static str> {
    match stage {
        SpecKitStage::Specify | SpecKitStage::Clarify => Some("spec.md"),
        SpecKitStage::Plan => Some("plan.md"),
        SpecKitStage::Tasks => Some("tasks.md"),
        SpecKitStage::Constitution | SpecKitStage::Analyze | SpecKitStage::Implement => None,
    }
}

/// Build the agent prompt for a stage run. SpecKit stages are Claude Code
/// project commands; the prompt is the slash command plus any free-form input
/// (the feature description for `specify`, clarification answers for `clarify`,
/// etc.). The command files derive the feature dir from the current git branch,
/// which is the feature slug.
pub fn stage_prompt(stage: SpecKitStage, input: Option<&str>) -> String {
    let cmd = slash_command(stage);
    match input.map(str::trim).filter(|s| !s.is_empty()) {
        Some(arg) => format!("{cmd} {arg}"),
        None => cmd.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Feature slug / dir
// ---------------------------------------------------------------------------

/// Derive the SpecKit feature slug (`NNN-slug`) from an issue.
///
/// The number is the issue's per-project number, zero-padded to 3 digits, and
/// the slug is derived from the title. Assigning it from the issue (rather than
/// scanning `specs/` per worktree) means concurrent features never collide. The
/// workspace branch is set to the same slug, so SpecKit's branch-derived feature
/// dir and the worktree branch line up.
pub fn feature_slug(issue_number: i64, title: &str) -> String {
    let slug = git_branch_id(title);
    if slug.is_empty() {
        format!("{issue_number:03}-feature")
    } else {
        format!("{issue_number:03}-{slug}")
    }
}

/// The feature dir relative to the repo root, e.g. `specs/001-webhook-retries`.
pub fn feature_dir(feature_slug: &str) -> String {
    format!("specs/{feature_slug}")
}

// ---------------------------------------------------------------------------
// tasks.md parsing
// ---------------------------------------------------------------------------

/// One scanned task line, retaining enough to rewrite the line in place.
struct ScannedTask {
    line_index: usize,
    /// Byte index, within the line, of the character inside the `[ ]` checkbox.
    checkbox_char_index: Option<usize>,
    id: String,
    description: String,
    file_paths: Vec<String>,
    parallelizable: bool,
    phase: Option<String>,
    done: bool,
}

/// Parse `tasks.md` into structured tasks plus the derived parallel layers.
pub fn parse_tasks_md(text: &str) -> SpecKitTasks {
    let scanned = scan_tasks(text);
    let tasks: Vec<SpecKitTask> = scanned
        .into_iter()
        .map(|s| SpecKitTask {
            id: s.id,
            description: s.description,
            file_paths: s.file_paths,
            parallelizable: s.parallelizable,
            phase: s.phase,
            done: s.done,
        })
        .collect();
    let completed = tasks.iter().filter(|t| t.done).count() as u32;
    let layers = compute_layers(&tasks);
    SpecKitTasks {
        total: tasks.len() as u32,
        completed,
        layers,
        tasks,
    }
}

/// Group tasks into ordered parallel-execution layers.
///
/// A run of consecutive `[P]` tasks forms one layer (they can run together).
/// A non-`[P]` task is a barrier: it forms its own singleton layer that runs
/// after the preceding group. `parallel` is true only when a layer holds more
/// than one task.
pub fn compute_layers(tasks: &[SpecKitTask]) -> Vec<SpecKitTaskLayer> {
    let mut layers: Vec<SpecKitTaskLayer> = Vec::new();
    let mut current: Vec<String> = Vec::new();

    let flush = |current: &mut Vec<String>, layers: &mut Vec<SpecKitTaskLayer>| {
        if !current.is_empty() {
            let task_ids = std::mem::take(current);
            layers.push(SpecKitTaskLayer {
                parallel: task_ids.len() > 1,
                task_ids,
            });
        }
    };

    for task in tasks {
        if task.parallelizable {
            current.push(task.id.clone());
        } else {
            flush(&mut current, &mut layers);
            layers.push(SpecKitTaskLayer {
                task_ids: vec![task.id.clone()],
                parallel: false,
            });
        }
    }
    flush(&mut current, &mut layers);
    layers
}

/// Toggle a task's checkbox by id, returning the rewritten `tasks.md`.
///
/// Matches the same ids `parse_tasks_md` reports (including fallback ordinals),
/// so the frontend round-trips cleanly. Returns the text unchanged if the id
/// isn't found or its line has no checkbox.
pub fn toggle_task(text: &str, task_id: &str, done: bool) -> String {
    let scanned = scan_tasks(text);
    let Some(target) = scanned.iter().find(|s| s.id == task_id) else {
        return text.to_string();
    };
    let Some(char_idx) = target.checkbox_char_index else {
        return text.to_string();
    };

    let mut lines: Vec<&str> = text.split('\n').collect();
    let Some(line) = lines.get(target.line_index).copied() else {
        return text.to_string();
    };
    let new_char = if done { 'x' } else { ' ' };
    let mut rewritten = String::with_capacity(line.len());
    rewritten.push_str(&line[..char_idx]);
    rewritten.push(new_char);
    rewritten.push_str(&line[char_idx + 1..]);
    lines[target.line_index] = &rewritten;
    lines.join("\n")
}

/// Scan `tasks.md` line by line, tracking the current phase heading and HTML
/// comment regions, and extract task lines with byte offsets for rewriting.
fn scan_tasks(text: &str) -> Vec<ScannedTask> {
    let mut out = Vec::new();
    let mut current_phase: Option<String> = None;
    let mut in_comment = false;
    let mut ordinal = 0u32;

    for (line_index, raw) in text.split('\n').enumerate() {
        let line = raw;
        let trimmed = line.trim();

        // Skip HTML comment regions so the template's conventions block doesn't
        // get parsed as tasks.
        if in_comment {
            if trimmed.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("<!--") {
            if !trimmed.contains("-->") {
                in_comment = true;
            }
            continue;
        }

        // Headings (level >= 2) set the current phase.
        if let Some(rest) = trimmed.strip_prefix("##") {
            let heading = rest.trim_start_matches('#').trim();
            if !heading.is_empty() {
                current_phase = Some(heading.to_string());
            }
            continue;
        }

        if let Some(mut parsed) = parse_task_line(line) {
            ordinal += 1;
            if parsed.id.is_empty() {
                parsed.id = format!("T{ordinal:03}");
            }
            out.push(ScannedTask {
                line_index,
                checkbox_char_index: parsed.checkbox_char_index,
                id: parsed.id,
                description: parsed.description,
                file_paths: parsed.file_paths,
                parallelizable: parsed.parallelizable,
                phase: current_phase.clone(),
                done: parsed.done,
            });
        }
    }
    out
}

struct ParsedLine {
    checkbox_char_index: Option<usize>,
    id: String,
    description: String,
    file_paths: Vec<String>,
    parallelizable: bool,
    done: bool,
}

/// Parse a single line into a task, or `None` if it isn't a task bullet.
///
/// Accepts `- [ ] T001 [P] Description`, `* [x] T002 ...`, and id-only bullets
/// `- T003 ...`. A line qualifies as a task only if it has a checkbox or a
/// `T<number>` id.
fn parse_task_line(line: &str) -> Option<ParsedLine> {
    let lead_ws = line.len() - line.trim_start().len();
    let after_ws = &line[lead_ws..];

    // Require a list bullet.
    let after_bullet = after_ws
        .strip_prefix("- ")
        .or_else(|| after_ws.strip_prefix("* "))
        .or_else(|| after_ws.strip_prefix("-\t"))
        .or_else(|| after_ws.strip_prefix("*\t"))?;
    let bullet_offset = line.len() - after_bullet.len();

    // Optional checkbox `[ ]` / `[x]` / `[X]`.
    let mut done = false;
    let mut checkbox_char_index = None;
    let mut rest = after_bullet;
    let cb_lead = after_bullet.len() - after_bullet.trim_start().len();
    let cb_candidate = &after_bullet[cb_lead..];
    let bytes = cb_candidate.as_bytes();
    if bytes.first() == Some(&b'[') && bytes.get(2) == Some(&b']') {
        let c = bytes[1];
        if c == b' ' || c == b'x' || c == b'X' {
            done = c == b'x' || c == b'X';
            checkbox_char_index = Some(bullet_offset + cb_lead + 1);
            rest = &cb_candidate[3..];
        }
    }

    // Strip a leading bold marker and whitespace.
    let mut rest = rest.trim_start();
    if let Some(r) = rest.strip_prefix("**") {
        rest = r.trim_start();
    }

    // Optional `T<number>` id as the first token.
    let mut id = String::new();
    if let Some(first) = rest.split_whitespace().next()
        && let Some(parsed_id) = extract_id(first)
    {
        id = parsed_id;
        // Advance past the id token.
        if let Some(pos) = rest.find(first) {
            rest = rest[pos + first.len()..].trim_start();
        }
    }

    // Not a task line unless we found a checkbox or an id.
    if checkbox_char_index.is_none() && id.is_empty() {
        return None;
    }

    // Optional `[P]` parallel marker.
    let mut parallelizable = false;
    if let Some(r) = rest
        .strip_prefix("[P]")
        .or_else(|| rest.strip_prefix("[p]"))
    {
        parallelizable = true;
        rest = r.trim_start();
    }

    let description = rest
        .trim()
        .trim_end_matches("**")
        .trim_start_matches("**")
        .trim()
        .to_string();
    let file_paths = extract_file_paths(&description);

    Some(ParsedLine {
        checkbox_char_index,
        id,
        description,
        file_paths,
        parallelizable,
        done,
    })
}

/// Recognize a `T<number>` id token, tolerating trailing punctuation / bold.
fn extract_id(token: &str) -> Option<String> {
    let t = token.trim_matches('*').trim_end_matches([':', '.', ')']);
    let mut chars = t.chars();
    let first = chars.next()?;
    if first != 'T' && first != 't' {
        return None;
    }
    let digits: String = chars.collect();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("T{digits}"))
}

/// Pull file paths out of a task description: backtick-wrapped spans first, then
/// any bare slash-containing tokens.
fn extract_file_paths(description: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut rest = description;
    while let Some(start) = rest.find('`') {
        let after = &rest[start + 1..];
        if let Some(end) = after.find('`') {
            let span = after[..end].trim();
            if span.contains('/') || span.contains('.') {
                paths.push(span.to_string());
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }
    if paths.is_empty() {
        for tok in description.split_whitespace() {
            let cleaned = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '.');
            if cleaned.contains('/') && !cleaned.is_empty() {
                paths.push(cleaned.to_string());
            }
        }
    }
    paths
}

// ---------------------------------------------------------------------------
// Scaffold provisioning
// ---------------------------------------------------------------------------

const CONSTITUTION_TEMPLATE: &str =
    include_str!("../../../../../assets/speckit/memory/constitution.md");
const SPEC_TEMPLATE: &str =
    include_str!("../../../../../assets/speckit/templates/spec-template.md");
const PLAN_TEMPLATE: &str =
    include_str!("../../../../../assets/speckit/templates/plan-template.md");
const TASKS_TEMPLATE: &str =
    include_str!("../../../../../assets/speckit/templates/tasks-template.md");

/// Where the constitution lives relative to a repo root.
pub const CONSTITUTION_REL_PATH: &str = ".specify/memory/constitution.md";

/// Ensure the `.specify/` scaffold and Claude Code SpecKit commands exist in the
/// repo worktree. Idempotent: existing files are left untouched so operator
/// edits (especially the constitution) survive re-runs.
///
/// This writes a self-contained vendored scaffold (no Python `specify` CLI
/// dependency): templates, a starter constitution, and the per-stage command
/// prompts under `.claude/commands/`.
pub fn ensure_scaffold(repo_path: &Path) -> io::Result<()> {
    for (rel, content) in scaffold_files() {
        let path = repo_path.join(&rel);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, content)?;
    }
    Ok(())
}

/// The vendored scaffold as (relative path, content) pairs.
fn scaffold_files() -> Vec<(PathBuf, String)> {
    let mut files = vec![
        (
            PathBuf::from(CONSTITUTION_REL_PATH),
            CONSTITUTION_TEMPLATE.to_string(),
        ),
        (
            PathBuf::from(".specify/templates/spec-template.md"),
            SPEC_TEMPLATE.to_string(),
        ),
        (
            PathBuf::from(".specify/templates/plan-template.md"),
            PLAN_TEMPLATE.to_string(),
        ),
        (
            PathBuf::from(".specify/templates/tasks-template.md"),
            TASKS_TEMPLATE.to_string(),
        ),
    ];
    for stage in SpecKitStage::ALL {
        let name = slash_command(stage).trim_start_matches('/');
        files.push((
            PathBuf::from(format!(".claude/commands/{name}.md")),
            command_file(stage),
        ));
    }
    files
}

/// Generate a Claude Code slash-command file for a stage. The feature dir is
/// derived from the current git branch (which is the feature slug).
fn command_file(stage: SpecKitStage) -> String {
    let body = match stage {
        SpecKitStage::Constitution => {
            "Create or update the project constitution at `.specify/memory/constitution.md`. \
             Use `.specify/templates` for structure if helpful. Capture the principles in $ARGUMENTS \
             (or refine the existing ones). Keep it concise and enforceable."
        }
        SpecKitStage::Specify => {
            "Write the feature specification. Read `.specify/templates/spec-template.md` and \
             `.specify/memory/constitution.md`. Write the spec to `specs/<current git branch>/spec.md`. \
             Focus on WHAT and WHY (functional requirements, user stories, acceptance criteria) — not \
             the tech stack. Mark anything unclear with `[NEEDS CLARIFICATION: ...]`. The feature \
             description: $ARGUMENTS"
        }
        SpecKitStage::Clarify => {
            "Review `specs/<current git branch>/spec.md` and resolve underspecified areas. If \
             answers are provided in $ARGUMENTS, fold them in and remove the matching \
             `[NEEDS CLARIFICATION]` markers. List any questions that remain open."
        }
        SpecKitStage::Plan => {
            "Read the spec, the constitution, and `.specify/templates/plan-template.md`. Write the \
             technical plan to `specs/<current git branch>/plan.md`, and, when relevant, \
             `research.md`, `data-model.md`, and `contracts/`. Ground every step in real files. \
             Confirm the approach honors the constitution."
        }
        SpecKitStage::Tasks => {
            "Read the plan and `.specify/templates/tasks-template.md`. Write \
             `specs/<current git branch>/tasks.md`: dependency-ordered tasks with stable `T###` ids, \
             `[P]` on tasks that touch independent files (parallel-safe), and the exact file path(s) \
             each task changes."
        }
        SpecKitStage::Analyze => {
            "Cross-check spec.md, plan.md, tasks.md, and the constitution under \
             `specs/<current git branch>/` for inconsistencies, coverage gaps, and constitution \
             violations. Report findings as a list, each tagged error/warning/info and naming the \
             artifact it concerns. Do not modify files."
        }
        SpecKitStage::Implement => {
            "Execute `specs/<current git branch>/tasks.md` in dependency order. Tasks marked `[P]` \
             within the same group may be done together. As you finish each task, mark its checkbox \
             `[x]` in tasks.md. Follow the plan and the constitution."
        }
    };
    format!(
        "# {cmd}\n\n{body}\n",
        cmd = slash_command(stage),
        body = body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# Tasks: Webhook retries

## Phase 1: Setup
- [ ] T001 [P] Create module in `src/retry/mod.rs`
- [x] T002 [P] Add types in `src/retry/types.rs`

## Phase 2: Core
- [ ] T003 Implement core in `src/retry/core.rs`
- [ ] T004 [P] Tests in `src/retry/tests.rs`

<!--
- [ ] T999 this is inside a comment and must be ignored
-->
"#;

    #[test]
    fn parses_tasks_with_ids_phases_and_markers() {
        let parsed = parse_tasks_md(SAMPLE);
        assert_eq!(parsed.total, 4);
        assert_eq!(parsed.completed, 1);

        let ids: Vec<&str> = parsed.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["T001", "T002", "T003", "T004"]);

        let t1 = &parsed.tasks[0];
        assert!(t1.parallelizable);
        assert!(!t1.done);
        assert_eq!(t1.phase.as_deref(), Some("Phase 1: Setup"));
        assert_eq!(t1.file_paths, ["src/retry/mod.rs"]);

        let t2 = &parsed.tasks[1];
        assert!(t2.done);

        let t3 = &parsed.tasks[2];
        assert!(!t3.parallelizable);
        assert_eq!(t3.phase.as_deref(), Some("Phase 2: Core"));
    }

    #[test]
    fn ignores_tasks_inside_html_comments() {
        let parsed = parse_tasks_md(SAMPLE);
        assert!(parsed.tasks.iter().all(|t| t.id != "T999"));
    }

    #[test]
    fn computes_parallel_layers() {
        let parsed = parse_tasks_md(SAMPLE);
        // T001,T002 parallel -> layer; T003 barrier -> singleton; T004 -> singleton.
        let layers = &parsed.layers;
        assert_eq!(layers.len(), 3);
        assert_eq!(layers[0].task_ids, ["T001", "T002"]);
        assert!(layers[0].parallel);
        assert_eq!(layers[1].task_ids, ["T003"]);
        assert!(!layers[1].parallel);
        assert_eq!(layers[2].task_ids, ["T004"]);
        assert!(!layers[2].parallel);
    }

    #[test]
    fn toggle_task_flips_checkbox() {
        let toggled = toggle_task(SAMPLE, "T001", true);
        let parsed = parse_tasks_md(&toggled);
        assert!(parsed.tasks[0].done);
        // Other lines untouched.
        assert!(parsed.tasks[1].done);
        assert!(!parsed.tasks[2].done);

        let back = toggle_task(&toggled, "T002", false);
        let parsed = parse_tasks_md(&back);
        assert!(!parsed.tasks[1].done);
    }

    #[test]
    fn toggle_unknown_task_is_noop() {
        let same = toggle_task(SAMPLE, "T404", true);
        assert_eq!(same, SAMPLE);
    }

    #[test]
    fn feature_slug_zero_pads_and_slugifies() {
        assert_eq!(feature_slug(1, "Webhook retries!"), "001-webhook-retries");
        assert_eq!(feature_slug(42, ""), "042-feature");
        assert_eq!(
            feature_dir("001-webhook-retries"),
            "specs/001-webhook-retries"
        );
    }

    #[test]
    fn stage_prompt_appends_input() {
        assert_eq!(
            stage_prompt(SpecKitStage::Specify, Some("  add retries  ")),
            "/speckit.specify add retries"
        );
        assert_eq!(stage_prompt(SpecKitStage::Plan, None), "/speckit.plan");
        assert_eq!(
            stage_prompt(SpecKitStage::Tasks, Some("   ")),
            "/speckit.tasks"
        );
    }

    #[test]
    fn scaffold_files_cover_templates_and_commands() {
        let files = scaffold_files();
        let paths: Vec<String> = files
            .iter()
            .map(|(p, _)| p.to_string_lossy().to_string())
            .collect();
        assert!(paths.iter().any(|p| p == CONSTITUTION_REL_PATH));
        assert!(paths.iter().any(|p| p.ends_with("spec-template.md")));
        assert!(
            paths
                .iter()
                .any(|p| p == ".claude/commands/speckit.specify.md")
        );
        // One command per stage + 4 template/constitution files.
        assert_eq!(files.len(), SpecKitStage::ALL.len() + 4);
    }
}
