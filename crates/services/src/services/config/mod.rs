use std::path::PathBuf;

use thiserror::Error;

pub mod editor;
mod versions;

pub use editor::EditorOpenError;

pub const DEFAULT_PR_DESCRIPTION_PROMPT: &str = r#"Update the PR that was just created with a better title and description.
The PR number is #{pr_number} and the URL is {pr_url}.

Analyze the changes in this branch and write:
1. A concise, descriptive title that summarizes the changes, postfixed with "(Vibe Kanban)"
2. A detailed description that explains:
   - What changes were made
   - Why they were made (based on the task context)
   - Any important implementation details
   - At the end, include a note: "This PR was written using [Vibe Kanban](https://vibekanban.com)"

Use the appropriate CLI tool to update the PR (gh pr edit for GitHub, az repos pr update for Azure DevOps)."#;

pub const DEFAULT_COMMIT_REMINDER_PROMPT: &str = "There are uncommitted changes. Please stage and commit them now with a descriptive commit message.";

/// Prompt for the "Generate spec" intake flow. A coding agent runs once,
/// non-interactively, in a throwaway worktree containing the project's repos,
/// and turns a rough one-line brief into a development-ready technical task.
/// The `{brief}` placeholder is substituted with the user's brief.
///
/// Hard requirements baked in: the agent must NOT ask questions (it is
/// single-shot), must stay read-only (no edits/commits/implementation), and
/// must end with a single fenced ```json block carrying `title` + `description`
/// so the backend can parse it deterministically.
pub const DEFAULT_SPEC_INTAKE_PROMPT: &str = r#"You are acting as a product manager. Turn the rough task brief below into a clear, development-ready technical task that a developer (or a planning step) can pick up cold.

ROUGH BRIEF:
{brief}

You are running NON-INTERACTIVELY and READ-ONLY:
- You CANNOT ask the user questions. Where the brief is ambiguous, make a sensible decision and record it under "Decisions made" as [assumed].
- Do NOT edit files, create files, run git, commit, or implement anything. You may read/grep/glob the repos in your working directory ONLY to ground your assumptions (confirm a named file/flag/endpoint/table really exists and means what the brief implies). Keep this light — a few lookups, not a full exploration.
- Produce the WHAT and the acceptance criteria, NOT the step-by-step implementation plan.

Read the brief for what's missing: open design decisions phrased as questions, vague verbs with no definition of done ("refactor", "improve"), bundled concerns, integration assumptions, and unstated scope edges. Resolve them in the spec.

Write a medium-length spec (about one screen) using exactly these sections, dropping any section that has nothing substantive:

## Outcome — what's different when this is done
Observable behavior/state, not implementation. 2–5 bullets.

## Scope
**In scope:** bullets. **Explicitly out of scope:** the tempting-but-not-now items.

## Technical requirements
Concrete, grounded, checkable constraints. Name real files/flags/endpoints you verified; mark anything unverified as [unverified]. 3–8 bullets.

## Decisions made
Every open decision you resolved + a few words of why. Mark defaults [assumed].

## Testing & acceptance criteria
How we'll know it works — concrete and checkable ("running X produces Y"). Cover the obvious edge cases.

## Risks, dependencies & open assumptions
Anything that could derail it, what it depends on, and every still-unconfirmed assumption.

OUTPUT CONTRACT (critical):
Your FINAL message must be EXACTLY one fenced code block tagged `json` and NOTHING before or after it, of the form:
```json
{"title": "<one-line title, terse and scannable, no 'Task:' prefix>", "description": "<the full markdown spec: the sections above>"}
```
The `description` value is a JSON string, so escape newlines as \n and quotes as \". Do not wrap the JSON in prose. Do not emit any text after the closing fence."#;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Validation error: {0}")]
    ValidationError(String),
}

pub type Config = versions::v9::Config;
pub type NotificationConfig = versions::v9::NotificationConfig;
pub type EditorConfig = versions::v9::EditorConfig;
pub type ThemeMode = versions::v9::ThemeMode;
pub type SoundFile = versions::v9::SoundFile;
pub type EditorType = versions::v9::EditorType;
pub type GitHubConfig = versions::v9::GitHubConfig;
pub type UiLanguage = versions::v9::UiLanguage;
pub type ShowcaseState = versions::v9::ShowcaseState;
pub type SendMessageShortcut = versions::v9::SendMessageShortcut;

/// Will always return config, trying old schemas or eventually returning default
pub async fn load_config_from_file(config_path: &PathBuf) -> Config {
    match std::fs::read_to_string(config_path) {
        Ok(raw_config) => Config::from(raw_config),
        Err(_) => {
            tracing::info!("No config file found, creating one");
            Config::default()
        }
    }
}

/// Saves the config to the given path
pub async fn save_config_to_file(
    config: &Config,
    config_path: &PathBuf,
) -> Result<(), ConfigError> {
    let raw_config = serde_json::to_string_pretty(config)?;
    std::fs::write(config_path, raw_config)?;
    Ok(())
}
