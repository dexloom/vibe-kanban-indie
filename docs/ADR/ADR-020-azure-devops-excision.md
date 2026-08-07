# ADR-020: Azure DevOps excision

- **Status**: Accepted
- **Date**: 2026-08-05
- **Refines**: ADR-018 (org excision — deferred Azure at §Risks); ADR-004 (local-only cloud removal)
- **Relates to**: crates/git-host (GitHub provider)

## Context

`crates/git-host` exposes a `GitHostProvider` trait with two implementations: `GitHubProvider` (the one real host used by this single-dev local fork) and `AzureDevOpsProvider`, which shells out to the `az` CLI. The `ProviderKind` enum and the `enum_dispatch`-based `GitHostService` exist only to switch between GitHub and Azure. Azure DevOps is never used in this fork — GitHub is the only PR host — and the `az` integration (~950 LOC across `azure/mod.rs` + `azure/cli.rs`) is pure dead weight. ADR-018 flagged Azure as out of scope and deferred it; this ADR closes that deferral.

## Decision

1. **Delete `crates/git-host/src/azure/`** entirely (`mod.rs`, `cli.rs`). Remove `pub mod azure;`, the `AzureDevOpsProvider` import, the `AzureDevOps(GitHostService)` enum variant, and the `from_url` match arm from `lib.rs`. Drop the `AzureDevOps` variant from `ProviderKind` and its `Display` arm in `types.rs`.
2. **Collapse `GitHostService` to a newtype struct over `GitHubProvider`** (drop the `enum_dispatch` machinery). `from_url` returns GitHub for GitHub URLs and `Err(UnsupportedProvider)` for everything else. The `GitHostProvider` trait is retained (still useful for `provider_kind()` and future-proofing) but the single-variant dispatch enum is gone. `enum_dispatch` is removed from `Cargo.toml`.
3. **`ProviderKind` becomes `{ GitHub, Unknown }`.** Do NOT add speculative `GitLab`/`Bitbucket` variants — they were never variants (those URLs always fell through to `Unknown`), and adding them would violate the excision principle.
4. **`detect_provider_from_url`** simplifies to a single GitHub check (URL contains `github.com` or `github.`); everything else → `Unknown`. Delete `detect_provider_from_pr_url` (test-only scaffolding that never shipped) and its tests.
5. **Trim `DEFAULT_PR_DESCRIPTION_PROMPT`**: the "az repos pr update for Azure DevOps" clause is removed; the prompt now says to use `gh pr edit`. (Regenerates the TS constant via `generate_types`.)
6. **Frontend**: drop the dead `azure_dev_ops` branch in `CreatePRDialog.tsx`'s provider-name mapping.
7. **Docs**: delete `docs/integrations/azure-repos-integration.mdx` + its `docs.json` nav entry.

## Consequences

### Positive
- ~950 LOC of dead Azure integration removed.
- `GitHostService` becomes honest (one host, no dispatch ceremony); `ProviderKind` is a two-value enum that matches reality.
- No consumer changes: `pr_monitor`, `repo.rs`, and `workspaces/pr.rs` have no `ProviderKind::AzureDevOps` match arms — they only pass `ProviderKind` as an opaque serialized field, so the variant removal flows through TS regeneration automatically.
- Cargo deps stay intact (every dep is shared with the GitHub module); only `enum_dispatch` is dropped.

### Negative / accepted
- `shared/types.ts` `ProviderKind` union loses `"azure_dev_ops"` — breaking for any out-of-repo consumer that matched on it (none in this repo; regenerated automatically).
- An `az`-using agent would now get `UnsupportedProvider` — correct for a GitHub-only fork.

## Risks

- **Match exhaustiveness**: only two match sites on `ProviderKind` exist (`lib.rs::from_url`, `types.rs::Display`), both being edited. Zero consumer match arms. No breakage.
- **`enum_dispatch` with single variant** (Option B2) avoided entirely by the newtype collapse (B1).
- **`shared/types.ts`** is auto-generated — never hand-edited; `pnpm run generate-types` handles it.
- **Doc references in ADR-018/019** are historical and kept verbatim; ADR-020 fulfils the deferral noted at ADR-018 §Risks.
