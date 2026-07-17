//! Bundled OpenCode subagent definitions — the opencode equivalents of the
//! Claude plugin's `sweeper` / `decider` / `intake` agents.
//!
//! `ensure_seeded(dir)` copies the bundled `vk-*.md` files into `<dir>/agents/`
//! non-destructively: a file is written only when it does not already exist, so
//! operator edits are never overwritten. The target is the opencode config
//! directory (global: `~/.config/opencode/`) so the opencode TUI — and a future
//! opencode-headed orchestrator — can spawn `vk-sweeper` / `vk-decider` /
//! `vk-intake` by name. The `vk-` prefix namespaces them apart from a user's own
//! opencode agents.

use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum OpencodeAgentError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Bundled opencode agent definitions (`(filename, contents)`).
const BUNDLED: &[(&str, &str)] = &[
    (
        "vk-sweeper.md",
        include_str!("../../../../assets/opencode-agents/vk-sweeper.md"),
    ),
    (
        "vk-decider.md",
        include_str!("../../../../assets/opencode-agents/vk-decider.md"),
    ),
    (
        "vk-intake.md",
        include_str!("../../../../assets/opencode-agents/vk-intake.md"),
    ),
];

/// Seed the bundled opencode agent files into `<dir>/agents/`, creating the
/// directory if needed. Non-destructive: an existing file is never overwritten,
/// so the operator's edits persist. Returns the number of files written.
pub fn ensure_seeded(dir: &Path) -> Result<usize, OpencodeAgentError> {
    let agents_dir = dir.join("agents");
    std::fs::create_dir_all(&agents_dir)?;
    let mut written = 0;
    for (name, contents) in BUNDLED {
        let target = agents_dir.join(name);
        if target.exists() {
            continue;
        }
        std::fs::write(&target, contents)?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_agent_files_are_nonempty() {
        for (name, contents) in BUNDLED {
            assert!(!contents.trim().is_empty(), "{name} is empty");
            // opencode agent frontmatter must declare a description.
            assert!(
                contents.contains("description:"),
                "{name} missing frontmatter description"
            );
        }
    }

    #[test]
    fn ensure_seeded_is_non_destructive() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        assert_eq!(ensure_seeded(dir).unwrap(), 3);
        // A second run writes nothing because the files already exist.
        assert_eq!(ensure_seeded(dir).unwrap(), 0);

        // An operator edit is preserved.
        let sweeper = dir.join("agents").join("vk-sweeper.md");
        std::fs::write(&sweeper, "EDITED").unwrap();
        assert_eq!(ensure_seeded(dir).unwrap(), 0);
        assert_eq!(std::fs::read_to_string(&sweeper).unwrap(), "EDITED");
    }
}
