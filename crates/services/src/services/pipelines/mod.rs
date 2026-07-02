//! File-based card pipelines.
//!
//! Each `~/.vibe-kanban/pipelines/*.toml` file defines one selectable pipeline:
//! a `name`, an optional `description`, and an ordered list of `[[stage]]`
//! tables. The file stem is the pipeline `id` (e.g. `basic.toml` → `basic`).
//!
//! ```toml
//! name = "Basic"
//! description = "Classic dev flow."
//!
//! [[stage]]
//! id = "spec"
//! label = "Create spec"
//! default_enabled = true
//! prompt = "Write a technical spec ..."
//! ```
//!
//! The New Issue dialog reads these (via `GET /api/pipelines`), the operator
//! picks one pipeline and ticks which stages apply, and vibe-kanban composes an
//! ordered `## Pipeline` block into the card description. Stages are ordered by
//! their position in the file. Bundled defaults are seeded to disk on first run.

use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use super::config::PipelineStep;

/// Bundled default pipeline files, seeded to `pipelines_dir()` on first run and
/// used by the reset actions. Order here defines the display order of bundled
/// pipelines in the UI.
const BUNDLED: &[(&str, &str)] = &[
    (
        "basic.toml",
        include_str!("../../../../../assets/pipelines/basic.toml"),
    ),
    (
        "wikillm.toml",
        include_str!("../../../../../assets/pipelines/wikillm.toml"),
    ),
    (
        "speckit.toml",
        include_str!("../../../../../assets/pipelines/speckit.toml"),
    ),
    (
        "async.toml",
        include_str!("../../../../../assets/pipelines/async.toml"),
    ),
];

/// A selectable card pipeline loaded from a `*.toml` file.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Pipeline {
    /// Stable slug = the file stem, e.g. "basic".
    pub id: String,
    /// Display name from the file's `name` field.
    pub name: String,
    /// Optional one-line description.
    pub description: Option<String>,
    /// Ordered stages; this order is authoritative for the composed block.
    pub stages: Vec<PipelineStep>,
}

#[derive(Debug, Error)]
pub enum PipelineError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("failed to parse pipeline TOML: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("invalid pipeline: {0}")]
    Invalid(String),
    #[error("pipeline not found")]
    NotFound,
    #[error("invalid pipeline id")]
    InvalidId,
}

#[derive(Debug, Deserialize)]
struct RawPipeline {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    stage: Vec<RawStage>,
}

#[derive(Debug, Deserialize)]
struct RawStage {
    id: String,
    label: String,
    prompt: String,
    #[serde(default)]
    default_enabled: bool,
}

/// A slug is a non-empty run of ASCII alphanumerics, `-`, or `_`. Used for both
/// pipeline ids (file stems) and stage ids. Rejects path traversal (`/`, `\`,
/// `..`) and anything that would collide oddly in the UI.
fn is_valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Validate an untrusted pipeline id (e.g. a route path param).
pub fn validate_id(id: &str) -> Result<(), PipelineError> {
    if is_valid_slug(id) {
        Ok(())
    } else {
        Err(PipelineError::InvalidId)
    }
}

/// Parse and validate a single pipeline's TOML. `id` is the file stem.
pub fn parse_pipeline(id: &str, raw: &str) -> Result<Pipeline, PipelineError> {
    validate_id(id)?;
    let parsed: RawPipeline = toml::from_str(raw)?;
    if parsed.name.trim().is_empty() {
        return Err(PipelineError::Invalid(
            "pipeline name must not be empty".to_string(),
        ));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut stages = Vec::with_capacity(parsed.stage.len());
    for st in parsed.stage {
        if !is_valid_slug(&st.id) {
            return Err(PipelineError::Invalid(format!(
                "invalid stage id: {:?}",
                st.id
            )));
        }
        if !seen.insert(st.id.clone()) {
            return Err(PipelineError::Invalid(format!(
                "duplicate stage id: {}",
                st.id
            )));
        }
        if st.label.trim().is_empty() {
            return Err(PipelineError::Invalid(format!(
                "stage {} label must not be empty",
                st.id
            )));
        }
        if st.prompt.trim().is_empty() {
            return Err(PipelineError::Invalid(format!(
                "stage {} prompt must not be empty",
                st.id
            )));
        }
        stages.push(PipelineStep {
            id: st.id,
            label: st.label,
            prompt_fragment: st.prompt,
            default_enabled: st.default_enabled,
        });
    }
    Ok(Pipeline {
        id: id.to_string(),
        name: parsed.name,
        description: parsed.description,
        stages,
    })
}

fn has_toml(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .ok()
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("toml"))
        })
        .unwrap_or(false)
}

/// Seed bundled defaults, but **only when the dir is absent or contains no
/// `*.toml`**. This means deleting one bundled file does not resurrect it on the
/// next load (as long as at least one pipeline file remains). If the operator
/// deletes *every* file, the defaults are re-seeded (documented edge case).
pub fn ensure_seeded(dir: &Path) -> Result<(), PipelineError> {
    if dir.exists() && has_toml(dir) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    for (name, content) in BUNDLED {
        let path = dir.join(name);
        if !path.exists() {
            std::fs::write(&path, content)?;
        }
    }
    Ok(())
}

/// Load every valid pipeline from `dir`, seeding defaults first if empty.
/// Malformed files are skipped with a warning so a single bad user file never
/// breaks the endpoint. Sorted: bundled order first, then alphabetical.
pub fn load_pipelines(dir: &Path) -> Vec<Pipeline> {
    if let Err(e) = ensure_seeded(dir) {
        tracing::warn!("failed to seed pipelines dir {}: {}", dir.display(), e);
    }
    let mut out: Vec<Pipeline> = Vec::new();
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            tracing::warn!("failed to read pipelines dir {}: {}", dir.display(), e);
            return out;
        }
    };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|x| x.to_str()) != Some("toml") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("skip pipeline {}: {}", path.display(), e);
                continue;
            }
        };
        match parse_pipeline(stem, &raw) {
            Ok(p) => out.push(p),
            Err(e) => tracing::warn!("skip invalid pipeline {}: {}", path.display(), e),
        }
    }
    let bundled_order = |id: &str| {
        BUNDLED
            .iter()
            .position(|(n, _)| n.trim_end_matches(".toml") == id)
    };
    out.sort_by(|a, b| match (bundled_order(&a.id), bundled_order(&b.id)) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    out
}

/// Read the raw TOML of a single pipeline (for the Settings editor).
pub fn read_raw(dir: &Path, id: &str) -> Result<String, PipelineError> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.toml"));
    if !path.exists() {
        return Err(PipelineError::NotFound);
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Validate and write raw TOML for a pipeline. Rejects content that fails to
/// parse **before** touching disk, returning the parsed pipeline on success.
pub fn write_raw(dir: &Path, id: &str, content: &str) -> Result<Pipeline, PipelineError> {
    validate_id(id)?;
    let pipeline = parse_pipeline(id, content)?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(format!("{id}.toml")), content)?;
    Ok(pipeline)
}

/// Restore a single bundled pipeline to its shipped default.
pub fn reset_one(dir: &Path, id: &str) -> Result<Pipeline, PipelineError> {
    validate_id(id)?;
    let file = format!("{id}.toml");
    let Some((_, content)) = BUNDLED.iter().find(|(n, _)| *n == file) else {
        return Err(PipelineError::NotFound);
    };
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(&file), content)?;
    parse_pipeline(id, content)
}

/// Overwrite all bundled pipelines with their shipped defaults, propagating any
/// write error rather than returning a stale/partial list.
pub fn reset_all(dir: &Path) -> Result<Vec<Pipeline>, PipelineError> {
    std::fs::create_dir_all(dir)?;
    for (name, content) in BUNDLED {
        std::fs::write(dir.join(name), content)?;
    }
    Ok(load_pipelines(dir))
}

/// Delete a pipeline file. Stays deleted while other pipeline files remain.
pub fn delete_pipeline(dir: &Path, id: &str) -> Result<(), PipelineError> {
    validate_id(id)?;
    let path = dir.join(format!("{id}.toml"));
    if !path.exists() {
        return Err(PipelineError::NotFound);
    }
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Unique temp dir per test invocation (avoids a tempfile dev-dependency).
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!(
                "vk-pipelines-test-{}-{}",
                std::process::id(),
                n
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_valid_pipeline() {
        let raw = r#"
            name = "Demo"
            [[stage]]
            id = "spec"
            label = "Create spec"
            default_enabled = true
            prompt = "Write a spec."
        "#;
        let p = parse_pipeline("demo", raw).unwrap();
        assert_eq!(p.id, "demo");
        assert_eq!(p.name, "Demo");
        assert_eq!(p.stages.len(), 1);
        assert_eq!(p.stages[0].id, "spec");
        assert_eq!(p.stages[0].prompt_fragment, "Write a spec.");
        assert!(p.stages[0].default_enabled);
    }

    #[test]
    fn rejects_duplicate_stage_ids() {
        let raw = r#"
            name = "Dup"
            [[stage]]
            id = "spec"
            label = "A"
            prompt = "x"
            [[stage]]
            id = "spec"
            label = "B"
            prompt = "y"
        "#;
        assert!(matches!(
            parse_pipeline("dup", raw),
            Err(PipelineError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_empty_fields_and_bad_ids() {
        let empty_label = "name=\"X\"\n[[stage]]\nid=\"a\"\nlabel=\"\"\nprompt=\"p\"\n";
        assert!(matches!(
            parse_pipeline("x", empty_label),
            Err(PipelineError::Invalid(_))
        ));
        let bad_stage = "name=\"X\"\n[[stage]]\nid=\"a b\"\nlabel=\"l\"\nprompt=\"p\"\n";
        assert!(matches!(
            parse_pipeline("x", bad_stage),
            Err(PipelineError::Invalid(_))
        ));
    }

    #[test]
    fn validate_id_rejects_traversal() {
        assert!(validate_id("..").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("a\\b").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("basic").is_ok());
        assert!(validate_id("my_pipeline-2").is_ok());
    }

    #[test]
    fn seeds_defaults_into_empty_dir() {
        let d = TmpDir::new();
        let pipelines = load_pipelines(d.path());
        let ids: Vec<_> = pipelines.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["basic", "wikillm", "speckit", "async"]);
    }

    #[test]
    fn does_not_reseed_deleted_file_when_others_remain() {
        let d = TmpDir::new();
        ensure_seeded(d.path()).unwrap();
        delete_pipeline(d.path(), "basic").unwrap();
        let pipelines = load_pipelines(d.path());
        assert!(!pipelines.iter().any(|p| p.id == "basic"));
        assert!(pipelines.iter().any(|p| p.id == "wikillm"));
    }

    #[test]
    fn skips_malformed_file_but_keeps_valid_ones() {
        let d = TmpDir::new();
        ensure_seeded(d.path()).unwrap();
        std::fs::write(d.path().join("broken.toml"), "this is = not [valid").unwrap();
        let pipelines = load_pipelines(d.path());
        assert!(pipelines.iter().any(|p| p.id == "basic"));
        assert!(!pipelines.iter().any(|p| p.id == "broken"));
    }

    #[test]
    fn write_raw_rejects_invalid_toml() {
        let d = TmpDir::new();
        assert!(write_raw(d.path(), "custom", "not valid = [").is_err());
        assert!(!d.path().join("custom.toml").exists());
    }

    #[test]
    fn reset_one_and_all_restore_bundled() {
        let d = TmpDir::new();
        ensure_seeded(d.path()).unwrap();
        std::fs::write(d.path().join("basic.toml"), "name=\"Hacked\"\n").unwrap();
        let restored = reset_one(d.path(), "basic").unwrap();
        assert_eq!(restored.name, "Basic");
        assert!(reset_one(d.path(), "not-bundled").is_err());
        let all = reset_all(d.path()).unwrap();
        assert!(all.iter().any(|p| p.id == "basic" && p.name == "Basic"));
    }

    #[test]
    fn bundled_basic_spec_prompt_is_verbatim() {
        let d = TmpDir::new();
        let pipelines = load_pipelines(d.path());
        let basic = pipelines.iter().find(|p| p.id == "basic").unwrap();
        let spec = basic.stages.iter().find(|s| s.id == "spec").unwrap();
        assert_eq!(
            spec.prompt_fragment,
            "Write a technical spec for this card and save it to `SPEC.md` at the repo root before implementing."
        );
    }
}
