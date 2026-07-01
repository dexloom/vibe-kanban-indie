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

/// Built-in catalog of per-card pipeline steps, used when
/// `Config::pipeline_steps` is `None`. This is the single source of truth for
/// the defaults: it is exported to TypeScript as `DEFAULT_PIPELINE_STEPS` so
/// the frontend renders the same set when the operator hasn't customised it.
/// All steps start unticked (`default_enabled: false`).
pub fn default_pipeline_steps() -> Vec<PipelineStep> {
    vec![
        PipelineStep {
            id: "orchestrate".to_string(),
            label: "Orchestrate (auto-drive)".to_string(),
            prompt_fragment:
                "Have the orchestrator agent pick this card up and drive it to done autonomously, running the card's pipeline stages in order — regardless of which board column the card is in (it may be started even from Todo)."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "spec".to_string(),
            label: "Create spec".to_string(),
            prompt_fragment:
                "Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "recall-knowledge".to_string(),
            label: "Recall prior knowledge".to_string(),
            prompt_fragment:
                "Before planning, recall what this project already knows: search the project knowledge base for pages relevant to this card and distill the matches into a `PRIOR_KNOWLEDGE.md` at the workspace root for the spec and plan stages to build on. Read-only on the knowledge base; if it is empty (first card), note that and continue."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "plan".to_string(),
            label: "Create plan".to_string(),
            prompt_fragment:
                "Write a step-by-step implementation plan and save it to `IMPLEMENTATION_PLAN.md` at the repo root."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "plan-review".to_string(),
            label: "Review plan".to_string(),
            prompt_fragment:
                "Have the implementation plan reviewed (e.g. a codex plan review, read-only) and resolve blockers before writing code."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "wait-for-approval".to_string(),
            label: "Wait for approval".to_string(),
            prompt_fragment:
                "Pause for operator approval at this point: commit the work so far, then stop and wait for the operator's decision or instructions before continuing to later stages — do not advance on your own until the operator responds."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "code-review".to_string(),
            label: "Review code".to_string(),
            prompt_fragment:
                "After implementing, run a code review on the diff and address findings before marking the card ready."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "update-docs".to_string(),
            label: "Update documentation".to_string(),
            prompt_fragment:
                "Update the documentation affected by this change so the docs match what shipped, and commit it before marking the card ready."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "enrich-knowledge".to_string(),
            label: "Enrich knowledge base".to_string(),
            prompt_fragment:
                "Once the change is implemented (and reviewed/documented, if those stages ran), distill any reusable knowledge from what shipped into the project knowledge base: add or update topic pages, tag each with this card's id, refresh the index, and commit the knowledge base before marking the card ready. If nothing reusable emerged, say so (\"no new knowledge to record\") rather than writing filler."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "merge".to_string(),
            label: "Merge to base".to_string(),
            prompt_fragment:
                "When the work is implemented and reviewed, merge this card's branch into the base branch."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "pr".to_string(),
            label: "Open pull request".to_string(),
            prompt_fragment:
                "When the work is implemented and reviewed, open a pull request for this card against the base branch."
                    .to_string(),
            default_enabled: false,
        },
        // SpecKit (Spec-Driven Development) mode — an opt-in alternative to the
        // classic spec/plan steps above. Each runs the matching SpecKit slash
        // command in the feature worktree, writing artifacts under
        // `specs/<branch>/`. The dedicated SpecKit workbench drives these
        // interactively; enabling them here lets the orchestrator auto-drive a
        // SpecKit card in order.
        PipelineStep {
            id: "speckit-constitution".to_string(),
            label: "SpecKit: Constitution".to_string(),
            prompt_fragment:
                "SpecKit: establish or refresh the project constitution at `.specify/memory/constitution.md` (run `/speckit.constitution`) before specifying."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-specify".to_string(),
            label: "SpecKit: Specify".to_string(),
            prompt_fragment:
                "SpecKit: write the feature specification to `specs/<current branch>/spec.md` (run `/speckit.specify`), focusing on what and why."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-clarify".to_string(),
            label: "SpecKit: Clarify".to_string(),
            prompt_fragment:
                "SpecKit: resolve the spec's open questions (run `/speckit.clarify`) before planning."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-plan".to_string(),
            label: "SpecKit: Plan".to_string(),
            prompt_fragment:
                "SpecKit: write the technical plan to `specs/<current branch>/plan.md` plus research/data-model/contracts as needed (run `/speckit.plan`)."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-tasks".to_string(),
            label: "SpecKit: Tasks".to_string(),
            prompt_fragment:
                "SpecKit: break the plan into a dependency-ordered, parallel-aware `specs/<current branch>/tasks.md` (run `/speckit.tasks`)."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-analyze".to_string(),
            label: "SpecKit: Analyze".to_string(),
            prompt_fragment:
                "SpecKit: cross-check spec, plan, and tasks for gaps and constitution violations (run `/speckit.analyze`) before implementing."
                    .to_string(),
            default_enabled: false,
        },
        PipelineStep {
            id: "speckit-implement".to_string(),
            label: "SpecKit: Implement".to_string(),
            prompt_fragment:
                "SpecKit: execute `specs/<current branch>/tasks.md` in dependency order, doing `[P]` tasks within a layer together and ticking each task off as it lands (run `/speckit.implement`)."
                    .to_string(),
            default_enabled: false,
        },
    ]
}

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
pub type PipelineStep = versions::v9::PipelineStep;
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
