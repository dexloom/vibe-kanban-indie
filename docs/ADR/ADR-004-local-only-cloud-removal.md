# ADR-004: Local-only fork — remove the cloud stack, keep remote-types.ts as a live contract

- **Status**: Accepted
- **Date**: 2026-08-02

## Context

The fork's purpose is a single-developer, self-hosted, local-only product (no team, no
cloud, no auth). The codebase inherited a large cloud stack: the `crates/remote` server,
relay/tunnel/WebRTC crates, oauth + auth, analytics + PostHog + Sentry telemetry, the
`packages/remote-web` frontend, and an ElectricSQL data layer in the web UI.

## Decision

Remove the cloud stack in phases (compile cuts → telemetry/relay/cloud-front/cloud crates
→ final telemetry/UI dead code):

1. Delete the cloud crates and frontends: `crates/remote`, `crates/relay-tunnel`,
   `crates/relay-hosts`, `crates/relay-webrtc`, `crates/remote-info`,
   `packages/remote-web`, plus `remote:*` scripts, Docker args, and CI jobs. (~70k LOC
   removed across the branches.)
2. Strip telemetry: `utils/sentry` + `sentry-tracing`, `@sentry/react`,
   `@sentry/vite-plugin`, PostHog init/provider/tracking, and all
   `POSTHOG/SENTRY/VK_SHARED_API_BASE/VK_SHARED_RELAY_API_BASE` build-env passthrough.
3. Collapse organizations to a single synthetic `"Local"` org (`routes/organizations.rs`);
   invitations/membership return "not supported". Org-scoped project data flow is kept
   (the kanban layer is org-scoped).
4. **`shared/remote-types.ts` is RETAINED as a live, hand-maintained wire contract.**
   Despite being historically generated from the now-deleted `crates/remote`, it is the
   shape contract for the kanban data layer (`providers/remote/*`,
   `integrations/electric/*`, `lib/electric/*`) used by the local UI in fallback-REST mode.
   Its generator is gone; edits are made by hand.
5. `config` schema drops `analytics_enabled` / `relay_enabled` in the newest version while
   old migration versions are preserved for backward compat.

## Consequences

- Positive: a ~42k-LOC cloud/remote stack is gone; the release binary shrank (~89MB →
  ~69MB); no outbound telemetry; local-only deploy is self-contained.
- Negative: `shared/remote-types.ts` must be maintained by hand (no generator); some stale
  frontend imports still reference remote-era shapes (cleaned incrementally); the
  synthetic single org is a pragmatic stub, not a real multi-org model.
- Ongoing: treat `crates/remote`/relay docs as historical; never reintroduce cloud
  dependencies into the workspace; the macOS Swift app mirrors `remote-types.ts` shapes.
