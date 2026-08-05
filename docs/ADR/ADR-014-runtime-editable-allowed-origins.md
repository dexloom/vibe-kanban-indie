# ADR-014: Runtime-Editable Allowed Origins

**Status**: Accepted
**Date**: 2026-08-05

## Context

The backend rejects browser requests whose `Origin` header isn't in an allow-list enforced by the `validate_origin` middleware (`crates/server/src/middleware/origin.rs`). The list was configured only via the `VK_ALLOWED_ORIGINS` env var, read once into a process-wide `OnceLock`.

The dev script (`package.json` `dev`/`dev:qa`/`tauri:dev`) seeds `VK_ALLOWED_ORIGINS="http://localhost:${FRONTEND_PORT}"` — localhost only. Any access to the app through the machine's LAN IP (e.g. `http://192.168.1.218:3001`) sends `Origin: http://192.168.1.218:3001`, which is not in the allow-list. The middleware responds HTTP 403 to browser requests (curl/node omit the `Origin` header and pass — which is why the failure only reproduced from a real browser):

- WebSocket upgrades (e.g. `/api/workspaces/streams/ws`) get 403 → the `Ready` message never arrives → `isWorkspacesListInitialized` stays `false` → the sidebar shows an infinite spinner.
- `POST /v1/projects` gets 403 → "Failed to create project".

Fixing it required restarting the server with a new env value — slow, and the env only covered the one host the operator thought of at launch time.

## Decision

Make the allowed-origin list runtime-editable from the Settings UI while keeping the env var as a bootstrap fallback.

1. **Config field**: add `allowed_origins: Vec<String>` to `Config` (`crates/services/src/services/config/versions/v9.rs`), `#[serde(default)]` empty. No `config_version` bump — serde default lets existing v9 configs load unchanged; a bump adds a full `versions/vN.rs` migration for a pure UI extension.

2. **Middleware cache**: replace the `OnceLock<Vec<OriginKey>>` in `crates/server/src/middleware/origin.rs` with a module-level `RwLock<Vec<OriginKey>>`, seeded from `VK_ALLOWED_ORIGINS` on first access, and overwritten from the saved config via a new `set_allowed_origins(&[String])` function. The middleware signature stays a plain `FnMut(&mut Request) -> Result<(), Response>`, so `ValidateRequestHeaderLayer::custom` at both router sites (`crates/server/src/routes/mod.rs` `/api` and `/v1`) is unchanged. One shared cache serves both routers.

3. **Hot reload**: `update_config` (`crates/server/src/routes/config.rs`) calls `set_allowed_origins(&new_config.allowed_origins)` after a successful save, while holding the config write lock — no restart needed, no torn reads.

4. **Precedence**: the config list is the source of truth. If the config field is empty, the env seed is kept (preserves existing env-only setups). `set_allowed_origins` with an empty list is a no-op.

5. **Lockout safety**: loopback origins (`host == "localhost"`, which `normalize_host` also maps loopback IPs to) and same-origin requests are always allowed, regardless of the config list. A user cannot lock themselves out of the Settings UI.

6. **Frontend**: a "Network" settings card renders a comma-separated text input. On save the CSV is split, each entry validated as an `http(s)` URL, and pushed as `Vec<String>` into the config draft.

## Consequences

**Positive:**
- LAN / tunnel / VPN access is fixable from the UI without a server restart; the infinite-spinner and create-project 403 root causes are eliminated.
- Existing env-based setups keep working unchanged (env remains the fallback).
- Self-lockout is impossible (loopback + same-origin always allowed).
- No breaking config change: old v9 config files load with an empty list.

**Negative:**
- A new module-level mutable static (`RwLock`) in the middleware — justified because it matches the existing `OnceLock` ergonomics and avoids router surgery to thread `State` through both layer sites.
- Per-request `RwLock::read` cost (negligible, uncontended in the single-user fork).

**Risk:** if the backend ever runs multi-process, each process must re-seed the cache from persisted config at startup (already true); a `PUT` would need fan-out. Out of scope for the single-process local-only fork.

## Alternatives considered

- **`axum::middleware::from_fn_with_state`**: would require restructuring both router layer sites and threading `DeploymentImpl` into the middleware. Bigger blast radius, zero benefit for a single cache.
- **Drop `changeOrigin: true` on the vite proxies**: lets the same-origin short-circuit pass any host, but changes the `Host` header the backend sees — a larger semantic change needing an audit of `Host`-reading handlers.
- **Disable the middleware for the local deployment**: removes CSRF protection entirely; the origin check still has value (e.g. a malicious website calling the local API from the operator's browser). Rejected.
- **Env-only fix (add LAN IP to `VK_ALLOWED_ORIGINS`)**: works but requires editing `package.json` and restarting for every new host; the runtime-UI approach subsumes it.
