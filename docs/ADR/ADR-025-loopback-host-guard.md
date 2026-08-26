# ADR-025: Host Header Guard (DNS-Rebinding Defence)

**Status**: Accepted
**Date**: 2026-08-25 (amended 2026-08-26: widened to IP literals; added the layer argument)

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
   - **any IP literal** that is not an unspecified address, in any spelling
     (`127.0.0.1`, `192.168.1.50`, `100.101.102.103`, `[::1]`,
     `[0:0:0:0:0:0:0:1]`, `[2001:db8::1]`).

   Any port, or no port. `127.0.0.1.evil.com`, `192.168.1.50.evil.com`,
   `100.101.102.103.nip.io`, `localhost.evil.com` and `notlocalhost` all fail —
   none parses as an `IpAddr`. `0.0.0.0` and `::` are **excluded**: they are not
   a legitimate destination (see `utils::net::dialable_host`) and some browsers
   route `http://0.0.0.0:<port>` from a public page straight to the local
   server, so accepting them would reopen the hole from the other side.

   See **Why IP literals need no configuration** below for why this is not a
   weakening.

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

6. **Opt-out** — the `VK_ALLOWED_HOSTS` env var, unset by default, and needed
   only for **hostnames**. Comma separated; each entry is a bare authority
   (`vk.example.com`, `app:3000`) or a full URL whose authority is taken
   (`https://vk.example.com`), so the values already in `VK_ALLOWED_ORIGINS` can
   be pasted in. An entry without a port matches that host on any port; port
   pinning is meaningful only for names, since an IP literal is accepted on
   every port regardless. The single entry `*` accepts any Host header.

7. **Preview proxy** — `validate_preview_proxy_host` is the same guard plus
   `*.localhost`, because `preview_proxy::proxy_subdomain_request` addresses
   upstream dev servers as `<target_port>.localhost:<proxy_port>`. RFC 6761
   reserves `.localhost` to loopback and it is not registrable in public DNS,
   so it is not a rebinding vector. Attached to the proxy router in
   `main.rs`/`startup.rs`; the main router does **not** accept it.

8. **403 body** — `text/plain` naming the rejected Host (filtered to authority
   characters and truncated before being echoed), the rule, why it exists, and
   the `VK_ALLOWED_HOSTS` escape hatch.

## Why IP literals need no configuration

Rebinding cannot produce an IP-literal `Host`. The browser puts the URL's
authority into the header, so a rebound request carries the attacker's *name*
(`evil.com`) regardless of which address that name was made to resolve to. To
make a browser send `Host: 192.168.1.50:3000`, the page must fetch that URL
directly — which is plainly cross-origin, and `validate_origin` rejects it: the
`Origin` is `http://evil.com`, `origin_matches_host` is false, `evil.com` is not
`localhost`, it is not in the allow-list, and the authority derived from the Host
header (`192.168.1.50`, port 3000) does not equal the origin key (`evil.com`,
port 80). So the **pair** of checks covers what neither covers alone. The same
holds for `no-cors` fetches and cross-site form POSTs, both of which send
`Origin`.

Origin-less vectors (`<img>`, `<script>`, a GET form navigation) do reach the
handler, but there is no `CorsLayer` anywhere in this workspace (tower-http's
`cors` feature is enabled and unused), so the response is unreadable —
side-effect-only CSRF. That is *unchanged* by widening past loopback:
`<img src="http://127.0.0.1:3000/…">` from a public page already passed under a
loopback-only rule, so allowing `192.168.x` gives an attacker nothing new. No
`Host` guard can close that class; blocking Origin-less requests would break the
TUI, the MCP server and `curl`.

Consequence: LAN-by-IP, Tailscale-by-IP (CGNAT `100.64/10`), Docker with
`HOST=0.0.0.0` browsed by IP, and any VPS public IP all work with **no
configuration and no restart**. What still needs an entry is name-based access
only — Tailscale MagicDNS names, `host.local`, reverse-proxy vanity domains, and
container names such as `app:3000`.

**Why the name residue is unavoidable.** At the moment the request arrives, a
legitimate `Host: vk.example.com` and a rebound `Host: evil.com` are
byte-for-byte indistinguishable: same shape, same Origin/Host agreement. The
only difference is whether the operator *intended* that name, and that
information is not in the request. Every route to inferring it fails — a DNS
lookup is defeated because the attacker owns the DNS (their name resolves to the
local address at our lookup time too, which is the whole trick); Origin
correlation *is* the rebinding signature; and first-request-wins pinning is a
race whose outcome is decided by whoever boots first, breaks at restart, and
lets an attacker who wins the race pin `evil.com`. Name-based deployment
therefore requires out-of-band operator input. This is information-theoretic,
not an implementation limit.

## Why this belongs in the app and not in the reverse proxy

The objection is reasonable: this instance never faces the public internet
directly, so why is Host validation not one line of Traefik/Caddy/nginx config
plus documentation?

Because **a reverse proxy is an edge control and DNS rebinding is not an edge
attack.** The attacker is not on the internet reaching in — the attacker is
JavaScript running in a developer's own browser, already inside the perimeter,
opening a TCP connection to the `address:port` *it* chooses. It chooses the
app's port, not the edge's. With the app on `127.0.0.1:3000` and Traefik on
`:443`, `http://evil.com:3000/` resolving to `127.0.0.1` lands on the app and
the proxy logs nothing. The edge protects the path *through* the edge; it cannot
protect a port it does not own.

An edge could only cover this if the app's socket were unreachable from the
victim's browser except via the proxy. That is not what this repository ships:
`Dockerfile` sets `ENV HOST=0.0.0.0` and `EXPOSE 3000`, and
`docs/self-hosting/deploy-docker.mdx` documents `-p 3000:3000`, which publishes
the port to the host. Even an unpublished container port stays host-routable on
Linux via the container IP. And the app cannot *observe* any of this — whether a
proxy exists, whether it terminates Host, whether the port is published — so
relying on it would mean depending on an unverifiable control.

The non-proxied deployments are also the majority for a single-developer tool:
`npx vibe-kanban-indie` (binds loopback, opens a browser), `pnpm run dev`, the
Tauri desktop app's embedded server, `vibe-tui`, and a laptop compose. None has
an edge to terminate Host at, and all of them were rebinding-exploitable before
this guard, because `validate_origin`'s same-origin short-circuit is exactly what
rebinding satisfies and there is no authentication.

Blast radius justifies the cheap control: the guarded router merges
`filesystem::router`, `repo::router`, `scratch::router` and `terminal::router`
with no authentication, so a successful rebind means file access and
process/terminal control on the developer's machine.

Finally, this is where the HTTP specification puts it: RFC 9110 §7.2 makes the
**origin server** responsible for rejecting a request whose target authority it
does not serve. A proxy can help by rewriting `Host`; it cannot hold the
authority for which authorities the origin answers to.

**What is conceded:** for a deployment that genuinely always sits behind a
proxy, this guard is duplicative — defence in depth with a real, if small, cost.
The price is one line, the operator's choice of `VK_ALLOWED_HOSTS=vk.example.com`
or a proxy-side `Host` rewrite (`Caddyfile.example` in this repository does the
latter).

## Consequences

**Positive:**
- DNS rebinding against the local server is blocked for every route, including
  the static frontend and WebSocket upgrades — a gap `validate_origin` never
  covered.
- Secure by default: a stock `npx vibe-kanban-indie` install needs no
  configuration and gains the protection.
- One placement, one predicate; no per-route opt-in to forget.

**Negative / breaking:**
- **Name-based access breaks until `VK_ALLOWED_HOSTS` is set.** Reaching the
  board at a Tailscale MagicDNS name, an mDNS `.local` name, a reverse-proxy
  vanity domain, or a container name now returns 403 with the explanation.
  IP-addressed access — including LAN and Tailscale CGNAT addresses — is
  unaffected and needs no configuration. This is a deliberate, documented break
  for the name case; it previously worked with no configuration at all, because
  `validate_origin`'s same-origin short-circuit accepted it, which is precisely
  the rebinding hole.
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
  a name. Followed to its conclusion, this is the reasoning that widened the
  rule to *all* IP literals.
- **Loopback-only, with `VK_ALLOWED_HOSTS` for everything else** (as first
  implemented): safe, but it broke LAN and Tailscale-by-IP users who had never
  configured anything, for no security benefit — see **Why IP literals need no
  configuration**.
- **Push Host validation to the reverse proxy and ship documentation instead of
  a guard**: rejected on topology, not preference — see **Why this belongs in
  the app and not in the reverse proxy**.
- **First-request-wins pinning** (learn the authority the server is first
  reached on): a race with a security-critical loser, and it dies at restart.
- **Resolve the Host and check whether it points at us**: defeated by the
  attacker owning the DNS, which is the premise of the attack.
