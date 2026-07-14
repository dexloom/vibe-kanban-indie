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
        "async-opus.toml",
        include_str!("../../../../../assets/pipelines/async-opus.toml"),
    ),
    (
        "async-sonnet.toml",
        include_str!("../../../../../assets/pipelines/async-sonnet.toml"),
    ),
    (
        "async-fable.toml",
        include_str!("../../../../../assets/pipelines/async-fable.toml"),
    ),
];

/// The bundled set that existed before the seed manifest shipped. Frozen
/// forever: used only to backfill `.seed-manifest.json` for installs that
/// predate it (see `ensure_seeded_with`). Never add to this list — new
/// bundled files are tracked by `BUNDLED` and seed once on first sight.
const LEGACY_BASELINE: &[&str] = &["basic.toml", "wikillm.toml", "speckit.toml", "async.toml"];

/// Retired bundled filenames, paired with **every historical shipped content
/// version** of that file. `ensure_seeded_with` removes a retired file from a
/// user's pipelines dir only when its on-disk bytes exactly match one of
/// these versions (pristine, never user-edited); an edited copy is treated as
/// user content and left alone.
///
/// `async.toml` was split into `async-sonnet.toml` + `async-fable.toml`; its
/// four shipped versions (original, VIBE-2, VIBE-3, VIBE-4) are preserved
/// verbatim under `assets/pipelines/retired/` so installs seeded at any point
/// in its history can be safe-deleted.
const RETIRED: &[(&str, &[&str])] = &[(
    "async.toml",
    &[
        include_str!("../../../../../assets/pipelines/retired/async.toml.v1"),
        include_str!("../../../../../assets/pipelines/retired/async.toml.v2"),
        include_str!("../../../../../assets/pipelines/retired/async.toml.v3"),
        include_str!("../../../../../assets/pipelines/retired/async.toml.v4"),
    ],
)];

/// On-disk seed manifest (`.seed-manifest.json`): the set of bundled
/// filenames seeding has handled at least once. Dotted/non-`.toml` so it is
/// invisible to `load_pipelines`, `load_pipeline_statuses`, and the Settings
/// UI (all iterate `*.toml` only).
const MANIFEST_FILE: &str = ".seed-manifest.json";

#[derive(Debug, Serialize, Deserialize)]
struct SeedManifest {
    version: u32,
    seeded: Vec<String>,
}

fn manifest_path(dir: &Path) -> std::path::PathBuf {
    dir.join(MANIFEST_FILE)
}

/// Outcome of reading the seed manifest off disk.
enum ManifestRead {
    /// Parsed successfully; the recorded `seeded` set.
    Ok(HashSet<String>),
    /// Present but failed to parse. Treated conservatively: never resurrect a
    /// deleted bundled file just because the manifest is unreadable.
    Corrupt,
    /// No manifest file (pre-manifest install).
    Absent,
}

fn read_manifest(dir: &Path) -> ManifestRead {
    let path = manifest_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<SeedManifest>(&raw) {
            Ok(m) => ManifestRead::Ok(m.seeded.into_iter().collect()),
            Err(e) => {
                tracing::warn!(
                    "corrupt pipeline seed manifest {}: {} — treating as untouched, not resurrecting deletions",
                    path.display(),
                    e
                );
                ManifestRead::Corrupt
            }
        },
        Err(_) => ManifestRead::Absent,
    }
}

/// Write the seed manifest atomically (tmp file + rename) so a crash mid-write
/// never leaves a half-written manifest behind. Names are sorted for stable
/// diffs.
fn write_manifest_atomic(dir: &Path, seeded: &HashSet<String>) -> Result<(), PipelineError> {
    let mut names: Vec<String> = seeded.iter().cloned().collect();
    names.sort();
    let manifest = SeedManifest {
        version: 1,
        seeded: names,
    };
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let tmp_path = dir.join(format!("{MANIFEST_FILE}.tmp"));
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, manifest_path(dir))?;
    Ok(())
}

/// Ensure `names` are present in the seed manifest, preserving whatever is
/// already recorded. Called after `reset_one`/`reset_all` write bundled
/// content directly, so the manifest stays a superset of everything
/// seeding/reset has ever written verbatim (deletions of a reset file remain
/// sticky, same as first-seed deletions).
fn mark_seeded(dir: &Path, names: &[&str]) -> Result<(), PipelineError> {
    std::fs::create_dir_all(dir)?;
    let (mut seeded, mut dirty) = match read_manifest(dir) {
        ManifestRead::Ok(s) => (s, false),
        ManifestRead::Corrupt | ManifestRead::Absent => (HashSet::new(), true),
    };
    for n in names {
        if seeded.insert((*n).to_string()) {
            dirty = true;
        }
    }
    if dirty {
        write_manifest_atomic(dir, &seeded)?;
    }
    Ok(())
}

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

/// A structured TOML parse/validation error, suitable for surfacing inline in
/// the Settings editor (message plus a best-effort 1-based line/column when
/// the underlying `toml` parser exposes a byte span).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PipelineParseError {
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Result of validating a pipeline TOML draft (`POST /api/pipelines/validate`).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PipelineValidation {
    pub valid: bool,
    pub error: Option<PipelineParseError>,
}

/// Per-file status for every `~/.vibe-kanban/pipelines/*.toml` file, including
/// ones that currently fail to parse (and are therefore invisible to
/// `load_pipelines`/`GET /api/pipelines`).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct PipelineFileStatus {
    pub id: String,
    pub name: String,
    pub stage_count: Option<u32>,
    pub valid: bool,
    pub error: Option<PipelineParseError>,
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
    #[serde(default)]
    heavy: bool,
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
            heavy: st.heavy,
        });
    }
    Ok(Pipeline {
        id: id.to_string(),
        name: parsed.name,
        description: parsed.description,
        stages,
    })
}

/// Convert a byte offset into 1-based (line, column) by scanning `content`.
/// `\n` bumps the line and resets the column; anything else advances the
/// column by one char. O(offset), fine for the small pipeline files here.
fn offset_to_line_col(content: &str, offset: usize) -> (u32, u32) {
    let mut line: u32 = 1;
    let mut col: u32 = 1;
    for (idx, ch) in content.char_indices() {
        if idx >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

/// Build a structured error from a `PipelineError`, attaching line/column
/// when the error is a TOML syntax error with a byte span; message-only for
/// semantic errors (`Invalid`/`InvalidId`/`NotFound`/`Io`).
pub fn structured_error(e: &PipelineError, content: &str) -> PipelineParseError {
    match e {
        PipelineError::Parse(de) => {
            let message = {
                let m = de.message();
                if m.is_empty() {
                    e.to_string()
                } else {
                    m.to_string()
                }
            };
            let (line, column) = match de.span() {
                Some(span) => {
                    let (l, c) = offset_to_line_col(content, span.start);
                    (Some(l), Some(c))
                }
                None => (None, None),
            };
            PipelineParseError {
                message,
                line,
                column,
            }
        }
        other => PipelineParseError {
            message: other.to_string(),
            line: None,
            column: None,
        },
    }
}

/// Validate a pipeline TOML draft without touching disk.
pub fn validate(id: &str, content: &str) -> PipelineValidation {
    match parse_pipeline(id, content) {
        Ok(_) => PipelineValidation {
            valid: true,
            error: None,
        },
        Err(e) => PipelineValidation {
            valid: false,
            error: Some(structured_error(&e, content)),
        },
    }
}

/// Sort order shared by `load_pipelines` and `load_pipeline_statuses`:
/// bundled files first (in `BUNDLED` order), then alphabetical by id.
fn bundled_order(id: &str) -> Option<usize> {
    BUNDLED
        .iter()
        .position(|(n, _)| n.trim_end_matches(".toml") == id)
}

fn sort_by_bundled_order<T>(items: &mut [T], id_of: impl Fn(&T) -> &str) {
    items.sort_by(
        |a, b| match (bundled_order(id_of(a)), bundled_order(id_of(b))) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => id_of(a).cmp(id_of(b)),
        },
    );
}

/// Status for every `*.toml` file in `dir`, including malformed ones (which
/// `load_pipelines` silently skips). Seeds bundled defaults first, mirroring
/// `load_pipelines`.
pub fn load_pipeline_statuses(dir: &Path) -> Vec<PipelineFileStatus> {
    if let Err(e) = ensure_seeded(dir) {
        tracing::warn!("failed to seed pipelines dir {}: {}", dir.display(), e);
    }
    let mut out: Vec<PipelineFileStatus> = Vec::new();
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
        let stem = stem.to_string();
        match std::fs::read_to_string(&path) {
            Ok(raw) => match parse_pipeline(&stem, &raw) {
                Ok(p) => out.push(PipelineFileStatus {
                    id: p.id,
                    name: p.name,
                    stage_count: Some(p.stages.len() as u32),
                    valid: true,
                    error: None,
                }),
                Err(e) => out.push(PipelineFileStatus {
                    id: stem.clone(),
                    name: stem,
                    stage_count: None,
                    valid: false,
                    error: Some(structured_error(&e, &raw)),
                }),
            },
            Err(e) => out.push(PipelineFileStatus {
                id: stem.clone(),
                name: stem,
                stage_count: None,
                valid: false,
                error: Some(PipelineParseError {
                    message: e.to_string(),
                    line: None,
                    column: None,
                }),
            }),
        }
    }
    sort_by_bundled_order(&mut out, |s| s.id.as_str());
    out
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

/// Seed bundled defaults into `dir`, tracked by `.seed-manifest.json` so
/// updates to already-seeded installs are picked up exactly once per file
/// while user edits/deletions stay sticky. See `ensure_seeded_with` for the
/// full algorithm; this wraps it with the real bundled/retired/baseline
/// consts.
pub fn ensure_seeded(dir: &Path) -> Result<(), PipelineError> {
    ensure_seeded_with(dir, BUNDLED, RETIRED, LEGACY_BASELINE)
}

/// Testable seam behind `ensure_seeded`: takes the bundled set, the retired
/// set, and the legacy baseline as parameters so tests can exercise the
/// seeding/backfill/retirement rules with small fixtures instead of the real
/// (large) bundled pipeline files.
///
/// Algorithm:
/// - **Fresh dir** (absent or no `*.toml` at all — includes the "operator
///   wiped everything" edge case): write every bundled file, record all
///   bundled names as seeded, done. This preserves the pre-manifest behavior
///   for brand-new installs and full wipes.
/// - **Otherwise**, read the manifest:
///   - `Ok` → use its recorded `seeded` set.
///   - `Corrupt` → **never resurrect on corruption**: treat everything in
///     `baseline` and `bundled` as already seeded, then rewrite a valid
///     manifest.
///   - `Absent` (pre-manifest install: has TOMLs, no manifest yet) →
///     **backfill**: seed the set to `baseline` exactly (not disk contents,
///     not current `bundled`). Baseline names never re-seed even if the user
///     deleted them before the manifest existed; genuinely new bundled files
///     not in `baseline` still seed exactly once below.
/// - For each bundled `(name, content)` not already in `seeded`: write it iff
///   no file of that name exists yet (an existing same-named file is treated
///   as pre-existing user content and left untouched), then mark it seeded
///   either way.
/// - Sweep `retired`: remove a retired file only when its on-disk bytes match
///   one of its historical shipped versions exactly (pristine); an edited
///   copy is user content and is left alone.
/// - Write the manifest back (atomically: tmp file + rename) iff the seeded
///   set changed.
fn ensure_seeded_with(
    dir: &Path,
    bundled: &[(&str, &str)],
    retired: &[(&str, &[&str])],
    baseline: &[&str],
) -> Result<(), PipelineError> {
    std::fs::create_dir_all(dir)?;

    if !has_toml(dir) {
        for (name, content) in bundled {
            let path = dir.join(name);
            if !path.exists() {
                std::fs::write(&path, content)?;
            }
        }
        let seeded: HashSet<String> = bundled.iter().map(|(n, _)| n.to_string()).collect();
        write_manifest_atomic(dir, &seeded)?;
        return Ok(());
    }

    let (mut seeded, mut dirty) = match read_manifest(dir) {
        ManifestRead::Ok(s) => (s, false),
        ManifestRead::Corrupt => {
            let mut s: HashSet<String> = baseline.iter().map(|n| n.to_string()).collect();
            s.extend(bundled.iter().map(|(n, _)| n.to_string()));
            (s, true)
        }
        ManifestRead::Absent => (baseline.iter().map(|n| n.to_string()).collect(), true),
    };

    for (name, content) in bundled {
        if seeded.contains(*name) {
            continue;
        }
        let path = dir.join(name);
        if !path.exists() {
            std::fs::write(&path, content)?;
        }
        seeded.insert((*name).to_string());
        dirty = true;
    }

    for (name, versions) in retired {
        let path = dir.join(name);
        if let Ok(existing) = std::fs::read_to_string(&path)
            && versions.iter().any(|v| *v == existing)
        {
            let _ = std::fs::remove_file(&path);
        }
    }

    if dirty {
        write_manifest_atomic(dir, &seeded)?;
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
    sort_by_bundled_order(&mut out, |p| p.id.as_str());
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
    let Some((name, content)) = BUNDLED.iter().find(|(n, _)| *n == file) else {
        return Err(PipelineError::NotFound);
    };
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(&file), content)?;
    mark_seeded(dir, &[name])?;
    parse_pipeline(id, content)
}

/// Overwrite all bundled pipelines with their shipped defaults, propagating any
/// write error rather than returning a stale/partial list.
pub fn reset_all(dir: &Path) -> Result<Vec<Pipeline>, PipelineError> {
    std::fs::create_dir_all(dir)?;
    for (name, content) in BUNDLED {
        std::fs::write(dir.join(name), content)?;
    }
    mark_seeded(dir, &BUNDLED.iter().map(|(n, _)| *n).collect::<Vec<_>>())?;
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
        assert_eq!(
            ids,
            vec![
                "basic",
                "wikillm",
                "speckit",
                "async-opus",
                "async-sonnet",
                "async-fable"
            ]
        );
        assert!(d.path().join(".seed-manifest.json").exists());
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
    fn validate_reports_valid_pipeline() {
        let raw = r#"
            name = "Demo"
            [[stage]]
            id = "spec"
            label = "Create spec"
            prompt = "Write a spec."
        "#;
        let v = validate("demo", raw);
        assert!(v.valid);
        assert!(v.error.is_none());
    }

    #[test]
    fn validate_reports_toml_syntax_error_with_line_col() {
        let raw = "name = ";
        let v = validate("broken", raw);
        assert!(!v.valid);
        let err = v.error.expect("expected a structured error");
        assert!(err.line.is_some());
        assert!(err.column.is_some());
    }

    #[test]
    fn validate_reports_semantic_error_without_line_col() {
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
        let v = validate("dup", raw);
        assert!(!v.valid);
        let err = v.error.expect("expected a structured error");
        assert!(err.line.is_none());
        assert!(err.column.is_none());
    }

    #[test]
    fn load_pipeline_statuses_reports_good_and_broken_files() {
        let d = TmpDir::new();
        std::fs::write(
            d.path().join("good.toml"),
            "name = \"Good\"\n[[stage]]\nid = \"a\"\nlabel = \"A\"\nprompt = \"p\"\n",
        )
        .unwrap();
        std::fs::write(d.path().join("broken.toml"), "this is = not [valid").unwrap();
        let statuses = load_pipeline_statuses(d.path());
        let good = statuses.iter().find(|s| s.id == "good").unwrap();
        assert!(good.valid);
        assert_eq!(good.stage_count, Some(1));
        assert!(good.error.is_none());
        let broken = statuses.iter().find(|s| s.id == "broken").unwrap();
        assert!(!broken.valid);
        assert!(broken.error.is_some());
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

    // --- Seed-manifest tests (via the private `ensure_seeded_with` seam) ---

    fn manifest_seeded(dir: &Path) -> HashSet<String> {
        match read_manifest(dir) {
            ManifestRead::Ok(s) => s,
            ManifestRead::Corrupt => panic!("manifest is corrupt"),
            ManifestRead::Absent => panic!("manifest is absent"),
        }
    }

    #[test]
    fn backfill_seeds_only_new_files_into_legacy_dir() {
        let d = TmpDir::new();
        // Legacy install: four pre-manifest baseline files, user-edited (content
        // differs from what `bundled` would ship), no manifest yet.
        std::fs::write(d.path().join("a.toml"), "A-OLD").unwrap();
        std::fs::write(d.path().join("b.toml"), "B-OLD").unwrap();
        std::fs::write(d.path().join("c.toml"), "C-OLD").unwrap();
        std::fs::write(d.path().join("d.toml"), "D-OLD").unwrap();

        let baseline: &[&str] = &["a.toml", "b.toml", "c.toml", "d.toml"];
        let bundled: &[(&str, &str)] = &[
            ("a.toml", "A-NEW"),
            ("b.toml", "B-NEW"),
            ("c.toml", "C-NEW"),
            ("d.toml", "D-NEW"),
            ("e.toml", "E-NEW"),
            ("f.toml", "F-NEW"),
        ];
        ensure_seeded_with(d.path(), bundled, &[], baseline).unwrap();

        // New bundled files get written.
        assert_eq!(
            std::fs::read_to_string(d.path().join("e.toml")).unwrap(),
            "E-NEW"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.toml")).unwrap(),
            "F-NEW"
        );
        // Baseline files are byte-untouched (their user edits survive).
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.toml")).unwrap(),
            "A-OLD"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("b.toml")).unwrap(),
            "B-OLD"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("c.toml")).unwrap(),
            "C-OLD"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("d.toml")).unwrap(),
            "D-OLD"
        );

        let mut seeded: Vec<String> = manifest_seeded(d.path()).into_iter().collect();
        seeded.sort();
        assert_eq!(
            seeded,
            vec!["a.toml", "b.toml", "c.toml", "d.toml", "e.toml", "f.toml"]
        );
    }

    #[test]
    fn pre_manifest_deleted_baseline_file_stays_deleted() {
        let d = TmpDir::new();
        // Legacy dir missing `d.toml` (deleted before the manifest existed).
        std::fs::write(d.path().join("a.toml"), "A-OLD").unwrap();
        std::fs::write(d.path().join("b.toml"), "B-OLD").unwrap();
        std::fs::write(d.path().join("c.toml"), "C-OLD").unwrap();

        let baseline: &[&str] = &["a.toml", "b.toml", "c.toml", "d.toml"];
        let bundled: &[(&str, &str)] = &[
            ("a.toml", "A-NEW"),
            ("b.toml", "B-NEW"),
            ("c.toml", "C-NEW"),
            ("d.toml", "D-NEW"),
            ("e.toml", "E-NEW"),
        ];
        ensure_seeded_with(d.path(), bundled, &[], baseline).unwrap();

        assert!(!d.path().join("d.toml").exists());
        assert!(d.path().join("e.toml").exists());
    }

    #[test]
    fn newly_bundled_file_deleted_after_seed_stays_deleted() {
        let d = TmpDir::new();
        let bundled_v1: &[(&str, &str)] = &[("a.toml", "A")];
        ensure_seeded_with(d.path(), bundled_v1, &[], &[]).unwrap();

        let bundled_v2: &[(&str, &str)] = &[("a.toml", "A"), ("b.toml", "B")];
        ensure_seeded_with(d.path(), bundled_v2, &[], &[]).unwrap();
        assert!(d.path().join("b.toml").exists());

        std::fs::remove_file(d.path().join("b.toml")).unwrap();
        ensure_seeded_with(d.path(), bundled_v2, &[], &[]).unwrap();
        assert!(!d.path().join("b.toml").exists());
        assert!(d.path().join("a.toml").exists());
    }

    #[test]
    fn existing_user_file_with_bundled_name_not_overwritten() {
        let d = TmpDir::new();
        // `a.toml` makes the dir non-empty; `b.toml` predates `b` being bundled
        // (no manifest yet, `b.toml` not in baseline either).
        std::fs::write(d.path().join("a.toml"), "A-EXISTING").unwrap();
        std::fs::write(d.path().join("b.toml"), "USER-CONTENT").unwrap();

        let bundled: &[(&str, &str)] = &[("a.toml", "A-BUNDLED"), ("b.toml", "B-BUNDLED")];
        ensure_seeded_with(d.path(), bundled, &[], &[]).unwrap();

        assert_eq!(
            std::fs::read_to_string(d.path().join("b.toml")).unwrap(),
            "USER-CONTENT"
        );
        assert!(manifest_seeded(d.path()).contains("b.toml"));
    }

    #[test]
    fn retired_pristine_file_is_removed() {
        let d = TmpDir::new();
        // Matches the *older* (non-latest) historical version, proving the
        // sweep checks every version, not just the last one.
        std::fs::write(d.path().join("old.toml"), "V2-CONTENT").unwrap();

        let retired: &[(&str, &[&str])] =
            &[("old.toml", &["V1-CONTENT", "V2-CONTENT", "V3-CONTENT"])];
        ensure_seeded_with(d.path(), &[], retired, &[]).unwrap();

        assert!(!d.path().join("old.toml").exists());
    }

    #[test]
    fn retired_edited_file_is_preserved() {
        let d = TmpDir::new();
        std::fs::write(d.path().join("old.toml"), "USER-EDITED-CONTENT").unwrap();

        let retired: &[(&str, &[&str])] =
            &[("old.toml", &["V1-CONTENT", "V2-CONTENT", "V3-CONTENT"])];
        ensure_seeded_with(d.path(), &[], retired, &[]).unwrap();

        assert_eq!(
            std::fs::read_to_string(d.path().join("old.toml")).unwrap(),
            "USER-EDITED-CONTENT"
        );
    }

    #[test]
    fn wiping_all_tomls_reseeds_despite_manifest() {
        let d = TmpDir::new();
        let bundled: &[(&str, &str)] = &[("a.toml", "A"), ("b.toml", "B")];
        ensure_seeded_with(d.path(), bundled, &[], &[]).unwrap();

        std::fs::remove_file(d.path().join("a.toml")).unwrap();
        std::fs::remove_file(d.path().join("b.toml")).unwrap();
        // The manifest itself (a `.json` file, not `.toml`) survives the wipe.
        assert!(d.path().join(".seed-manifest.json").exists());

        ensure_seeded_with(d.path(), bundled, &[], &[]).unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("a.toml")).unwrap(),
            "A"
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("b.toml")).unwrap(),
            "B"
        );
    }

    #[test]
    fn corrupt_manifest_never_resurrects() {
        let d = TmpDir::new();
        std::fs::write(d.path().join("a.toml"), "A").unwrap();
        // `b.toml` is missing (deleted), and the manifest is garbage.
        std::fs::write(d.path().join(".seed-manifest.json"), "{ not valid json").unwrap();

        let baseline: &[&str] = &["a.toml", "b.toml"];
        let bundled: &[(&str, &str)] = &[("a.toml", "A"), ("b.toml", "B")];
        ensure_seeded_with(d.path(), bundled, &[], baseline).unwrap();

        assert!(!d.path().join("b.toml").exists());
        // The manifest was rewritten into a valid state.
        let seeded = manifest_seeded(d.path());
        assert!(seeded.contains("a.toml"));
        assert!(seeded.contains("b.toml"));
    }

    #[test]
    fn manifest_not_listed_by_statuses_or_pipelines() {
        let d = TmpDir::new();
        let pipelines = load_pipelines(d.path());
        assert!(d.path().join(".seed-manifest.json").exists());
        assert!(!pipelines.iter().any(|p| p.id.contains("seed-manifest")));

        let statuses = load_pipeline_statuses(d.path());
        assert!(!statuses.iter().any(|s| s.id.contains("seed-manifest")));
    }

    #[test]
    fn reset_one_marks_manifest() {
        let d = TmpDir::new();
        reset_one(d.path(), "basic").unwrap();
        assert!(manifest_seeded(d.path()).contains("basic.toml"));
    }
}
