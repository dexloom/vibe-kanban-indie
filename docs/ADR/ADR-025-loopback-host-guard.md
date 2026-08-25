# ADR-025: Loopback-Only Host Header Guard

**Status**: Accepted
**Date**: 2026-08-25

## Context

The backend binds to loopback by default, serves an unauthenticated single-user
board, and exposes filesystem, git and process-spawning endpoints. The only
thing between it and a hostile web page is the browser.

`validate_origin` (`crates/server/src/middleware/origin.rs`, ADR-024) checks the
`Origin` header, but it cannot stop **DNS rebinding**. An attacker serves a page
from `evil.com`, whose DNS record they then re-point at `127.0.0.1` with a short
TTL. The victim's browser re-resolves, connects to the local server, and now
`Origin: http://evil.com` and `Host: evil.com` *agree* — the same-origin
short-circuit in `validate_origin` accepts it, and the attacker's JavaScript
reads and writes the local API with the victim's machine as the origin.

What never agrees is the **Host**: rebinding delivers the attacker's *name* in
the `Host` header, because that is what the user's browser was told to fetch. A
loopback deployment legitimately sees only `localhost`, `127.0.0.0/8` or `[::1]`
there. Rejecting everything else closes the hole.

Two further gaps informed the design:

- `validate_origin` is attached per-sub-router (`/api`, `/v1`), so the embedded
  frontend's static routes (`/`, `/{*path}`) were never covered. A Host guard
  attached the same way would inherit that gap.
- LAN, Tailscale, Docker and reverse-proxy access are documented, supported
  setups (`docs/remote-access.mdx`, `docs/self-hosting/deploy-docker.mdx`,
  `mobile-testing.md`, `Caddyfile.example`; the image even ships
  `HOST=0.0.0.0`). Those deployments legitimately see a non-loopback Host and
  need an escape hatch.

## Decision

Add a Host-header guard next to the Origin check, and attach it to the
**outermost** router.

1. **Guard** — `validate_loopback_host` in
   `crates/server/src/middleware/origin.rs`, a
   `ValidateRequestHeaderLayer::custom` predicate with the same signature as
   `validate_origin`.

2. **Placement** — the last `.layer(...)` on the router returned by
   `routes::router()` (`crates/server/src/routes/mod.rs`), i.e. the outermost
   layer. That single site covers `/api/*`, `/v1/*`, WebSocket upgrades, the
   static frontend routes and the router fallback, and it runs before
   decompression and routing.

3. **Allowed set** — explicit, never a substring test:
   - the exact host `localhost` (ASCII-case-insensitive), or
   - an IP literal whose parsed `IpAddr::is_loopback()` holds — `127.0.0.0/8`
     and `::1`, in any spelling (`[::1]`, `[0:0:0:0:0:0:0:1]`, `[::0001]`).

   Any port, or no port. `127.0.0.1.evil.com`, `localhost.evil.com` and
   `notlocalhost` all fail. `0.0.0.0` is **excluded**: some browsers route
   `http://0.0.0.0:<port>` from a public page straight to the local server, so
   accepting it would reopen the hole from the other side.

4. **Fail closed on ambiguity** — a value is parsed as a *bare* authority and
   rejected outright if it contains `://`, `@` (userinfo — `Authority::host()`
   alone would report `evil.com@127.0.0.1` as loopback), `/`, `\`, `?`, `#` or
   whitespace, or if it does not round-trip through `http::uri::Authority`.
   Duplicate `Host` headers are rejected (ambiguity is a smuggling primitive),
   as is a `Host` header whose bytes are not valid text.

5. **Both authority carriers are checked** — HTTP/2 (`:authority`) and
   HTTP/1.1 absolute-form request targets put the authority in the URI rather
   than (or as well as) in `Host`. At least one must be present, and *every*
   one present must be allowed, so a foreign absolute-form target paired with a
   loopback `Host` does not pass.

6. **Opt-out** — the `VK_ALLOWED_HOSTS` env var, unset by default. Comma
   separated; each entry is a bare authority (`192.168.1.50:3000`) or a full URL
   whose authority is taken (`https://vk.example.com`), so the values already in
   `VK_ALLOWED_ORIGINS` can be pasted in. An entry without a port matches that
   host on any port. The single entry `*` accepts any Host header.

7. **Preview proxy** — `validate_preview_proxy_host` is the same guard plus
   `*.localhost`, because `preview_proxy::proxy_subdomain_request` addresses
   upstream dev servers as `<target_port>.localhost:<proxy_port>`. RFC 6761
   reserves `.localhost` to loopback and it is not registrable in public DNS,
   so it is not a rebinding vector. Attached to the proxy router in
   `main.rs`/`startup.rs`; the main router does **not** accept it.

8. **403 body** — `text/plain` naming the rejected Host (filtered to authority
   characters and truncated before being echoed), the rule, why it exists, and
   the `VK_ALLOWED_HOSTS` escape hatch.

## Consequences

**Positive:**
- DNS rebinding against the local server is blocked for every route, including
  the static frontend and WebSocket upgrades — a gap `validate_origin` never
  covered.
- Secure by default: a stock `npx vibe-kanban-indie` install needs no
  configuration and gains the protection.
- One placement, one predicate; no per-route opt-in to forget.

**Negative / breaking:**
- **Any existing non-loopback access breaks until `VK_ALLOWED_HOSTS` is set.**
  Reaching the board at `http://192.168.1.50:3000`, at a Tailscale name, or
  through a reverse proxy that forwards the public Host now returns 403 with the
  explanation. This is a deliberate, documented break — LAN access previously
  worked with no configuration at all, because `validate_origin`'s same-origin
  short-circuit accepted it (which is precisely the rebinding hole).
- The env var is read once into a `OnceLock`, so unlike `allowed_origins`
  (ADR-024) it needs a restart. It is deliberately **not** runtime-editable
  from the Settings UI: a wrong Host locks you out of every route including
  Settings, so a UI knob could not be used to recover. Env + restart is the
  only recovery path that always works.
- Reverse proxies that rewrite Host to loopback (Caddy's
  `reverse_proxy 127.0.0.1:3000` with `header_up Host {upstream_hostport}`) pass
  untouched; proxies that preserve the public Host (Caddy's default) need the
  public name in `VK_ALLOWED_HOSTS`.
- `HOST=0.0.0.0` made the local clients (TUI, Telegram bridge, MCP server) dial
  `http://0.0.0.0:<port>`, which the guard rejects. They now route the bind
  address through `utils::net::dialable_host`, mapping `0.0.0.0`/`::` to
  loopback.

## Alternatives considered

- **Extend `validate_origin` instead of adding a second predicate**: it is
  attached per-sub-router and the static frontend routes would stay uncovered.
  Moving it outward as well would have changed the Origin check's blast radius
  in the same commit; kept separate deliberately.
- **Enable the guard only when the server binds to loopback** (skip it when
  `HOST` is non-loopback): no documented setup breaks, but the opt-out becomes
  implicit and a Docker instance behind a public proxy silently loses the
  protection. Rejected in favour of an explicit, off-by-default opt-out.
- **Derive allowed hosts from `config.allowed_origins`**: attractive
  (zero-config for operators who already listed their origin) but wrong on two
  counts — LAN access needed no allow-list entry to work, so the list is usually
  empty for exactly the users who would be broken, and an origin allow-list is
  a statement about who may *call* the server, not about what it answers to.
- **A `Config` field + Settings UI knob, mirroring ADR-024**: unusable for
  recovery, because a rejected Host 403s the Settings UI too. Left as an open
  question for a future ADR if a config-file (not UI) knob is wanted.
- **Accept `127.0.0.1` only, not all of `127.0.0.0/8`**: no security gain. An
  IP-literal Host can only come from a human typing one; rebinding always yields
  a name.
