use std::{
    net::IpAddr,
    sync::{OnceLock, RwLock},
};

use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, header, uri::Authority},
    response::Response,
};
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq)]
struct OriginKey {
    https: bool,
    host: String,
    port: u16,
}

impl OriginKey {
    fn from_origin(origin: &str) -> Option<Self> {
        let url = Url::parse(origin).ok()?;
        let https = match url.scheme() {
            "http" => false,
            "https" => true,
            _ => return None,
        };
        let host = normalize_host(url.host_str()?);
        let port = url.port_or_known_default()?;
        Some(Self { https, host, port })
    }

    fn from_host_header(host: &str, https: bool) -> Option<Self> {
        let authority: axum::http::uri::Authority = host.parse().ok()?;
        let host = normalize_host(authority.host());
        let port = authority.port_u16().unwrap_or_else(|| default_port(https));
        Some(Self { https, host, port })
    }
}

#[allow(clippy::result_large_err)]
pub fn validate_origin<B>(req: &mut Request<B>) -> Result<(), Response> {
    let Some(origin) = get_origin_header(req) else {
        return Ok(());
    };

    if origin.eq_ignore_ascii_case("null") {
        return Err(forbidden());
    }

    let host = get_host_header(req);

    // quick short-circuit same-origin check
    if host.is_some_and(|host| origin_matches_host(origin, host)) {
        return Ok(());
    }

    let Some(origin_key) = OriginKey::from_origin(origin) else {
        return Err(forbidden());
    };

    // Loopback origins are always trusted (locks the user out of Settings
    // otherwise).
    if origin_key.host == "localhost" {
        return Ok(());
    }

    if allowed_origins_snapshot()
        .iter()
        .any(|allowed| allowed == &origin_key)
    {
        return Ok(());
    }

    if let Some(host_key) =
        host.and_then(|host| OriginKey::from_host_header(host, origin_key.https))
        && host_key == origin_key
    {
        return Ok(());
    }

    Err(forbidden())
}

fn get_origin_header<B>(req: &Request<B>) -> Option<&str> {
    get_header(req, header::ORIGIN)
}

fn get_host_header<B>(req: &Request<B>) -> Option<&str> {
    get_header(req, header::HOST)
}

fn get_header<B>(req: &Request<B>, name: header::HeaderName) -> Option<&str> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
}

fn forbidden() -> Response {
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn origin_matches_host(origin: &str, host: &str) -> bool {
    origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .is_some_and(|rest| rest.eq_ignore_ascii_case(host))
}

fn normalize_host(host: &str) -> String {
    let trimmed = host.trim().trim_start_matches('[').trim_end_matches(']');
    let lower = trimmed.to_ascii_lowercase();
    if lower == "localhost" {
        return "localhost".to_string();
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        if ip.is_loopback() {
            return "localhost".to_string();
        }
        return ip.to_string();
    }
    lower
}

fn default_port(https: bool) -> u16 {
    if https { 443 } else { 80 }
}

fn env_origins() -> Vec<OriginKey> {
    match std::env::var("VK_ALLOWED_ORIGINS") {
        Ok(value) => value
            .split(',')
            .filter_map(|o| OriginKey::from_origin(o.trim()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

static ALLOWED: OnceLock<RwLock<Vec<OriginKey>>> = OnceLock::new();

fn allowed_origins_snapshot() -> Vec<OriginKey> {
    ALLOWED
        .get_or_init(|| RwLock::new(env_origins()))
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Called by `update_config` after a successful save (and at startup to seed
/// from the saved Config). Accepts raw strings from Config; unparseable
/// entries are silently dropped (same as env path). An empty list resets the
/// cache to the env seed (the config list is the source of truth; clearing it
/// means "no extra origins").
pub fn set_allowed_origins(origins: &[String]) {
    let parsed = if origins.is_empty() {
        env_origins()
    } else {
        origins
            .iter()
            .filter_map(|o| OriginKey::from_origin(o.trim()))
            .collect()
    };
    let lock = ALLOWED.get_or_init(|| RwLock::new(env_origins()));
    let mut guard = lock.write().unwrap_or_else(|e| e.into_inner());
    *guard = parsed;
}

// ---------------------------------------------------------------------------
// Host-header guard (DNS-rebinding defence)
// ---------------------------------------------------------------------------
//
// The server binds to loopback and has no authentication, so the only thing
// standing between it and a hostile web page is the browser. A page on the
// public internet can point *its own* hostname at 127.0.0.1 (DNS rebinding)
// and then talk to this server as same-origin — the `Origin` check above
// passes, because origin and Host agree. What does not agree is the Host: it
// is the attacker's domain, never a loopback name. Rejecting non-loopback
// authorities closes that hole.
//
// The guard is a `ValidateRequestHeaderLayer::custom` predicate applied to the
// *outermost* router (see `crate::routes::router`), so it covers every route:
// `/api/*`, `/v1/*`, WebSocket upgrades, and the embedded frontend's static
// files.

/// Environment variable naming extra authorities the `Host` guard accepts.
///
/// Comma-separated, unset by default (loopback only). Each entry is either a
/// bare authority (`192.168.1.50:3000`, `vk.example.com`) or a full URL whose
/// authority is used (`https://vk.example.com`), so the values already used
/// for `VK_ALLOWED_ORIGINS` can be pasted in unchanged. An entry without a
/// port matches that host on any port. The single entry `*` accepts any Host
/// header, disabling the guard.
pub const ALLOWED_HOSTS_ENV: &str = "VK_ALLOWED_HOSTS";

/// A request authority, normalised for comparison.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedAuthority {
    /// Lowercased host with IPv6 brackets stripped and IP literals
    /// canonicalised (`[::0001]` -> `::1`).
    host: String,
    /// `Some` when the host is an IP literal.
    ip: Option<IpAddr>,
    /// `None` when the authority carried no explicit port.
    port: Option<u16>,
}

impl ParsedAuthority {
    /// Parse a *bare* authority (`host` / `host:port`). Fails closed on
    /// anything that is not exactly that: absolute-form URIs (`http://host/`),
    /// embedded userinfo (`evil.com@127.0.0.1`), paths, queries and
    /// whitespace are all rejected rather than normalised away.
    fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        if raw.contains("://")
            || raw.contains('@')
            || raw.contains('/')
            || raw.contains('\\')
            || raw.contains('?')
            || raw.contains('#')
            || raw.chars().any(char::is_whitespace)
        {
            return None;
        }

        let authority: Authority = raw.parse().ok()?;
        let host_part = authority.host();
        // The parser is lenient about trailing junk after a bracketed IPv6
        // host — `[::1].evil.com` parses with `host() == "[::1]"`. Require the
        // authority to be exactly its own host and port, so nothing outside
        // what we inspected can ride along.
        let round_trip = match authority.port_u16() {
            Some(port) => format!("{host_part}:{port}"),
            None => host_part.to_string(),
        };
        if round_trip != raw {
            return None;
        }

        let unbracketed = host_part
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(host_part);
        if unbracketed.is_empty() {
            return None;
        }
        let lower = unbracketed.to_ascii_lowercase();
        let ip = lower.parse::<IpAddr>().ok();
        let host = match ip {
            Some(ip) => ip.to_string(),
            None => lower,
        };

        Some(Self {
            host,
            ip,
            port: authority.port_u16(),
        })
    }

    /// `localhost`, or any IP literal in 127.0.0.0/8 or `::1`.
    ///
    /// Note that an IP literal Host can only come from a human typing one:
    /// DNS rebinding yields the attacker's *name* in the Host header, never an
    /// address. `0.0.0.0` is deliberately excluded — some browsers do route
    /// `http://0.0.0.0:<port>` from a public page to the local server.
    fn is_loopback(&self) -> bool {
        match self.ip {
            Some(ip) => ip.is_loopback(),
            None => self.host == "localhost",
        }
    }

    /// A `*.localhost` name. Reserved to loopback by RFC 6761 and not
    /// registrable in public DNS, so it is not a rebinding vector.
    fn is_localhost_subdomain(&self) -> bool {
        self.ip.is_none()
            && self.host.len() > ".localhost".len()
            && self.host.ends_with(".localhost")
    }
}

/// One entry of [`ALLOWED_HOSTS_ENV`].
#[derive(Clone, Debug, Eq, PartialEq)]
struct HostPattern {
    host: String,
    /// `None` matches any port.
    port: Option<u16>,
}

impl HostPattern {
    fn parse(entry: &str) -> Option<Self> {
        let entry = entry.trim();
        // Accept `http://host:port/...` as well as a bare `host:port`.
        let authority = match entry.split_once("://") {
            Some((_scheme, rest)) => rest.split('/').next()?,
            None => entry,
        };
        let parsed = ParsedAuthority::parse(authority)?;
        Some(Self {
            host: parsed.host,
            port: parsed.port,
        })
    }

    fn matches(&self, authority: &ParsedAuthority) -> bool {
        self.host == authority.host && (self.port.is_none() || self.port == authority.port)
    }
}

/// The configured exceptions to the loopback-only rule.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct HostPolicy {
    /// Set by the `*` entry: accept any Host header.
    allow_any: bool,
    extra: Vec<HostPattern>,
}

impl HostPolicy {
    fn parse_list(value: &str) -> Self {
        let mut policy = Self::default();
        for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            if entry == "*" {
                policy.allow_any = true;
                continue;
            }
            match HostPattern::parse(entry) {
                Some(pattern) => policy.extra.push(pattern),
                None => tracing::warn!(
                    "Ignoring unparseable {} entry: {:?}",
                    ALLOWED_HOSTS_ENV,
                    entry
                ),
            }
        }
        policy
    }

    fn allows(&self, authority: &ParsedAuthority, allow_localhost_subdomains: bool) -> bool {
        if self.allow_any {
            return true;
        }
        if authority.is_loopback() {
            return true;
        }
        if allow_localhost_subdomains && authority.is_localhost_subdomain() {
            return true;
        }
        self.extra.iter().any(|pattern| pattern.matches(authority))
    }
}

static ALLOWED_HOSTS: OnceLock<HostPolicy> = OnceLock::new();

fn allowed_hosts() -> &'static HostPolicy {
    ALLOWED_HOSTS.get_or_init(|| {
        let policy = match std::env::var(ALLOWED_HOSTS_ENV) {
            Ok(value) => HostPolicy::parse_list(&value),
            Err(_) => HostPolicy::default(),
        };
        if policy.allow_any {
            tracing::warn!(
                "{}=* — the Host check is disabled; any hostname pointed at this \
                 server can drive it from a browser",
                ALLOWED_HOSTS_ENV
            );
        } else if !policy.extra.is_empty() {
            tracing::info!(
                "Accepting requests for loopback plus {} configured host(s) from {}",
                policy.extra.len(),
                ALLOWED_HOSTS_ENV
            );
        }
        policy
    })
}

/// Reject requests whose authority is not loopback.
///
/// Applied to the outermost main router, so it covers `/api/*`, `/v1/*`,
/// WebSocket upgrades and static frontend files alike.
#[allow(clippy::result_large_err)]
pub fn validate_loopback_host<B>(req: &mut Request<B>) -> Result<(), Response> {
    check_host(req, allowed_hosts(), false)
}

/// The same guard for the preview proxy, which addresses upstream dev servers
/// as `<target_port>.localhost:<proxy_port>` (see
/// `preview_proxy::proxy_subdomain_request`), so it must also accept
/// `*.localhost`.
#[allow(clippy::result_large_err)]
pub fn validate_preview_proxy_host<B>(req: &mut Request<B>) -> Result<(), Response> {
    check_host(req, allowed_hosts(), true)
}

#[allow(clippy::result_large_err)]
fn check_host<B>(
    req: &Request<B>,
    policy: &HostPolicy,
    allow_localhost_subdomains: bool,
) -> Result<(), Response> {
    // Duplicate Host headers make "the" Host ambiguous — a request smuggling
    // primitive. hyper already rejects these on HTTP/1.1; fail closed anyway.
    if req.headers().get_all(header::HOST).iter().count() > 1 {
        tracing::warn!("Rejected request carrying multiple Host headers");
        return Err(host_forbidden(None));
    }

    let host_header = match req.headers().get(header::HOST) {
        None => None,
        Some(value) => match value.to_str() {
            Ok(value) => Some(value.trim()),
            // Present but not usable text: reject rather than fall through to
            // the URI authority.
            Err(_) => return Err(host_forbidden(None)),
        },
    };

    // HTTP/2 (`:authority`) and HTTP/1.1 absolute-form request targets carry
    // the authority in the URI instead of / as well as in `Host`. Require at
    // least one, and require *every* one present to be allowed, so pairing a
    // loopback `Host` with a foreign absolute-form target does not pass.
    let uri_authority = req.uri().authority().map(Authority::as_str);
    if host_header.is_none() && uri_authority.is_none() {
        tracing::warn!("Rejected request with no Host header and no request-target authority");
        return Err(host_forbidden(None));
    }

    for raw in [host_header, uri_authority].into_iter().flatten() {
        let allowed = ParsedAuthority::parse(raw)
            .is_some_and(|authority| policy.allows(&authority, allow_localhost_subdomains));
        if !allowed {
            tracing::warn!("Rejected request for non-loopback authority: {:?}", raw);
            return Err(host_forbidden(Some(raw)));
        }
    }

    Ok(())
}

/// Keep only characters that can legitimately appear in an authority before
/// echoing an attacker-controlled value back in the response body.
fn sanitize_authority(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '_'))
        .take(128)
        .collect()
}

fn host_forbidden(authority: Option<&str>) -> Response {
    let subject = match authority.map(sanitize_authority) {
        Some(host) if !host.is_empty() => format!("rejected Host `{host}`"),
        _ => "request has no usable Host header".to_string(),
    };
    let body = format!(
        "403 Forbidden: {subject}.\n\
         \n\
         This is a single-user local server. It only answers requests addressed to a\n\
         loopback authority — `localhost`, `127.0.0.0/8` or `[::1]`, on any port.\n\
         Any other Host header is treated as a DNS-rebinding attempt: a public website\n\
         can resolve its own hostname to 127.0.0.1 and then talk to this server from\n\
         your browser.\n\
         \n\
         To serve the board on another hostname (a LAN IP, a Tailscale name, or a\n\
         reverse-proxy domain), set {ALLOWED_HOSTS_ENV} before starting the server:\n\
         \n\
         \x20   {ALLOWED_HOSTS_ENV}=\"192.168.1.50:3000,vk.example.com\"\n\
         \n\
         An entry with no port matches any port; `{ALLOWED_HOSTS_ENV}=*` accepts any\n\
         Host header and is not recommended.\n"
    );
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::http::{Request, header};

    use super::*;

    // Tests share the module-level `ALLOWED` cache. Serialise every test that
    // touches `validate_origin` (it reads the cache) so they never observe a
    // partially-mutated list while a `set_allowed_origins` test runs.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn make_request(origin: Option<&str>, host: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().uri("/test").method("GET");
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        if let Some(host) = host {
            builder = builder.header(header::HOST, host);
        }
        builder.body(Body::empty()).unwrap()
    }

    fn is_forbidden(result: Result<(), Response>) -> bool {
        matches!(result, Err(resp) if resp.status() == StatusCode::FORBIDDEN)
    }

    #[test]
    fn no_origin_header_allows_request() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut req = make_request(None, Some("example.com"));
        assert!(validate_origin(&mut req).is_ok());
    }

    #[test]
    fn null_origin_is_forbidden() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for null in ["null", "NULL", "Null"] {
            let mut req = make_request(Some(null), Some("example.com"));
            assert!(is_forbidden(validate_origin(&mut req)));
        }
    }

    #[test]
    fn same_origin_allows_request() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // HTTP, HTTPS, with port, case-insensitive
        let cases = [
            ("http://example.com", "example.com"),
            ("https://example.com", "example.com"),
            ("http://example.com:8080", "example.com:8080"),
            ("http://EXAMPLE.COM", "example.com"),
        ];
        for (origin, host) in cases {
            let mut req = make_request(Some(origin), Some(host));
            assert!(validate_origin(&mut req).is_ok(), "{origin} vs {host}");
        }
    }

    #[test]
    fn cross_origin_forbidden() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let cases = [
            ("http://unknown.com", "example.com"),         // different host
            ("http://example.com:8080", "example.com:80"), // different port
            ("ftp://example.com", "example.com"),          // non-http scheme
            ("not-a-valid-url", "example.com"),            // invalid URL
            ("http://example.com", ""),                    // missing host (invalid)
        ];
        for (origin, host) in cases {
            let host_opt = if host.is_empty() { None } else { Some(host) };
            let mut req = make_request(Some(origin), host_opt);
            assert!(is_forbidden(validate_origin(&mut req)), "{origin}");
        }
    }

    #[test]
    fn loopback_addresses_normalized_and_equivalent() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // All loopback forms normalize to "localhost"
        assert_eq!(
            OriginKey::from_origin("http://localhost:3000")
                .unwrap()
                .host,
            "localhost"
        );
        assert_eq!(
            OriginKey::from_origin("http://127.0.0.1:3000")
                .unwrap()
                .host,
            "localhost"
        );
        assert_eq!(
            OriginKey::from_origin("http://[::1]:3000").unwrap().host,
            "localhost"
        );

        // Cross-loopback requests should be allowed
        let mut req = make_request(Some("http://127.0.0.1:3000"), Some("[::1]:3000"));
        assert!(validate_origin(&mut req).is_ok());
    }

    #[test]
    fn default_ports_handled_correctly() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            OriginKey::from_origin("http://example.com").unwrap().port,
            80
        );
        assert_eq!(
            OriginKey::from_origin("https://example.com").unwrap().port,
            443
        );

        // Explicit default port matches implicit
        let mut req = make_request(Some("http://example.com:80"), Some("example.com"));
        assert!(validate_origin(&mut req).is_ok());
    }

    #[test]
    fn loopback_origin_allowed_even_when_config_list_is_empty() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Reset to an empty list (no env seed in the test process unless
        // VK_ALLOWED_ORIGINS is set). Loopback must still pass.
        set_allowed_origins(&[]);
        let mut req = make_request(Some("http://localhost:3001"), Some("example.com:80"));
        assert!(validate_origin(&mut req).is_ok());
        let mut req = make_request(Some("http://127.0.0.1:3001"), Some("example.com:80"));
        assert!(validate_origin(&mut req).is_ok());
        // Sanity: an unrelated cross-origin is still rejected.
        let mut req = make_request(Some("http://lan.example:3001"), Some("example.com:80"));
        assert!(is_forbidden(validate_origin(&mut req)));
    }

    #[test]
    fn config_list_origin_is_allowed_after_set_allowed_origins() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let list = vec!["http://192.168.1.50:3001".to_string()];
        set_allowed_origins(&list);

        let mut req = make_request(Some("http://192.168.1.50:3001"), Some("example.com:80"));
        assert!(validate_origin(&mut req).is_ok());
    }

    #[test]
    fn unlisted_cross_origin_still_forbidden_after_set_allowed_origins() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let list = vec!["http://192.168.1.50:3001".to_string()];
        set_allowed_origins(&list);

        let mut req = make_request(Some("http://192.168.1.99:3001"), Some("example.com:80"));
        assert!(is_forbidden(validate_origin(&mut req)));
    }

    #[test]
    fn set_allowed_origins_with_empty_list_resets_to_env_seed() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // First seed a non-empty list...
        set_allowed_origins(&["http://192.168.1.50:3001".to_string()]);
        let mut req = make_request(Some("http://192.168.1.50:3001"), Some("example.com:80"));
        assert!(validate_origin(&mut req).is_ok());

        // ...then call with an empty list: the config list is cleared, so the
        // cache falls back to the env seed and the prior entry no longer passes.
        set_allowed_origins(&[]);
        let mut req = make_request(Some("http://192.168.1.50:3001"), Some("example.com:80"));
        assert!(
            is_forbidden(validate_origin(&mut req)),
            "empty set_allowed_origins must drop the prior config list"
        );
    }
}

#[cfg(test)]
mod host_tests {
    use axum::http::{HeaderValue, Request, header};

    use super::*;

    /// Default policy: loopback only, no configured exceptions. Used instead of
    /// `allowed_hosts()` so the matrix never depends on the test process's
    /// environment.
    fn strict() -> HostPolicy {
        HostPolicy::default()
    }

    fn request(host: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder().uri("/api/health").method("GET");
        if let Some(host) = host {
            builder = builder.header(header::HOST, host);
        }
        builder.body(Body::empty()).unwrap()
    }

    fn is_forbidden(result: Result<(), Response>) -> bool {
        matches!(result, Err(resp) if resp.status() == StatusCode::FORBIDDEN)
    }

    #[allow(clippy::result_large_err)]
    fn check(host: Option<&str>) -> Result<(), Response> {
        check_host(&request(host), &strict(), false)
    }

    #[test]
    fn loopback_ipv4_host_is_allowed() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:3000",
            "127.0.0.1:65535",
            // 127.0.0.0/8 is entirely loopback.
            "127.0.0.2:3000",
        ] {
            assert!(check(Some(host)).is_ok(), "{host} should be allowed");
        }
    }

    #[test]
    fn loopback_ipv6_host_is_allowed() {
        for host in [
            "[::1]",
            "[::1]:3000",
            // Alternative spellings normalise to ::1.
            "[0:0:0:0:0:0:0:1]:3000",
            "[::0001]:3000",
        ] {
            assert!(check(Some(host)).is_ok(), "{host} should be allowed");
        }
    }

    #[test]
    fn localhost_host_is_allowed() {
        for host in ["localhost", "localhost:3000", "LOCALHOST:3000", "LocalHost"] {
            assert!(check(Some(host)).is_ok(), "{host} should be allowed");
        }
    }

    #[test]
    fn non_loopback_host_is_forbidden() {
        for host in [
            "example.com",
            "example.com:3000",
            "192.168.1.50:3000",
            "10.0.0.5",
            "[2001:db8::1]:3000",
            // Not loopback, and reachable from a public page in some browsers.
            "0.0.0.0:3000",
            "[::]:3000",
        ] {
            assert!(is_forbidden(check(Some(host))), "{host} should be rejected");
        }
    }

    #[test]
    fn lookalike_hosts_are_forbidden() {
        // Substring matching would let every one of these through.
        for host in [
            "127.0.0.1.evil.com",
            "127.0.0.1.evil.com:3000",
            "localhost.evil.com",
            "notlocalhost",
            "localhost.",
            "evil-127.0.0.1.com",
            "[::1].evil.com",
            "[::1]:3000.evil.com",
            "[::1]evil.com",
            "xlocalhost:3000",
        ] {
            assert!(is_forbidden(check(Some(host))), "{host} should be rejected");
        }
    }

    #[test]
    fn missing_host_header_is_forbidden() {
        assert!(is_forbidden(check(None)));
    }

    #[test]
    fn empty_or_unusable_host_header_is_forbidden() {
        assert!(is_forbidden(check(Some(""))), "empty Host");
        assert!(is_forbidden(check(Some("   "))), "whitespace-only Host");

        // Present but not valid text: must not fall through to "absent".
        let mut req = Request::builder().uri("/api/health").method("GET");
        req = req.header(header::HOST, HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        let req = req.body(Body::empty()).unwrap();
        assert!(is_forbidden(check_host(&req, &strict(), false)));
    }

    #[test]
    fn userinfo_in_host_is_forbidden() {
        // `Authority` parsing alone would report the host as 127.0.0.1 here.
        for host in [
            "evil.com@127.0.0.1",
            "evil.com@127.0.0.1:3000",
            "127.0.0.1@evil.com",
            "user:pass@localhost:3000",
        ] {
            assert!(is_forbidden(check(Some(host))), "{host} should be rejected");
        }
    }

    #[test]
    fn absolute_form_host_value_is_forbidden() {
        for host in [
            "http://127.0.0.1:3000",
            "http://localhost",
            "localhost:3000/../evil",
            "localhost:3000?x=1",
            "localhost:3000#f",
            "localhost:3000 evil.com",
        ] {
            assert!(is_forbidden(check(Some(host))), "{host} should be rejected");
        }
    }

    #[test]
    fn foreign_request_target_authority_is_forbidden() {
        // Absolute-form request target (or HTTP/2 `:authority`) paired with a
        // loopback Host header: every authority present must be allowed.
        let req = Request::builder()
            .uri("http://evil.com/api/health")
            .method("GET")
            .header(header::HOST, "127.0.0.1:3000")
            .body(Body::empty())
            .unwrap();
        assert!(is_forbidden(check_host(&req, &strict(), false)));

        // A loopback `:authority` with no Host header (the HTTP/2 shape) passes.
        let req = Request::builder()
            .uri("http://localhost:3000/api/health")
            .method("GET")
            .body(Body::empty())
            .unwrap();
        assert!(check_host(&req, &strict(), false).is_ok());
    }

    #[test]
    fn duplicate_host_headers_are_forbidden() {
        let req = Request::builder()
            .uri("/api/health")
            .method("GET")
            .header(header::HOST, "localhost:3000")
            .header(header::HOST, "evil.com")
            .body(Body::empty())
            .unwrap();
        assert!(is_forbidden(check_host(&req, &strict(), false)));
    }

    #[test]
    fn localhost_subdomains_only_allowed_for_the_preview_proxy() {
        // `<port>.localhost:<proxy_port>` is how the preview proxy addresses
        // upstream dev servers; the main router must still reject it.
        for host in ["3000.localhost:3003", "myapp--3000.localhost:3003"] {
            assert!(is_forbidden(check(Some(host))), "{host} on main router");
            let req = request(Some(host));
            assert!(
                check_host(&req, &strict(), true).is_ok(),
                "{host} on preview proxy"
            );
        }
        // The bare suffix is not a subdomain, and a lookalike is still out.
        let req = request(Some(".localhost:3003"));
        assert!(is_forbidden(check_host(&req, &strict(), true)));
        let req = request(Some("3000.localhost.evil.com"));
        assert!(is_forbidden(check_host(&req, &strict(), true)));
    }

    #[test]
    fn configured_hosts_are_allowed() {
        let policy =
            HostPolicy::parse_list("192.168.1.50:3000, https://vk.example.com , tailscale-host");
        assert!(!policy.allow_any);

        // Exact host:port match.
        assert!(check_host(&request(Some("192.168.1.50:3000")), &policy, false).is_ok());
        // Wrong port for an entry that pinned one.
        assert!(is_forbidden(check_host(
            &request(Some("192.168.1.50:3999")),
            &policy,
            false
        )));
        // A URL entry contributes its authority; no port means any port.
        assert!(check_host(&request(Some("vk.example.com")), &policy, false).is_ok());
        assert!(check_host(&request(Some("vk.example.com:8443")), &policy, false).is_ok());
        assert!(check_host(&request(Some("tailscale-host:3000")), &policy, false).is_ok());
        // Everything unlisted stays out.
        assert!(is_forbidden(check_host(
            &request(Some("evil.com")),
            &policy,
            false
        )));
        // Including lookalikes of a listed host.
        assert!(is_forbidden(check_host(
            &request(Some("vk.example.com.evil.com")),
            &policy,
            false
        )));
    }

    #[test]
    fn wildcard_entry_disables_the_guard_but_still_needs_an_authority() {
        let policy = HostPolicy::parse_list("*");
        assert!(policy.allow_any);
        assert!(check_host(&request(Some("evil.com")), &policy, false).is_ok());
        // `*` is an escape hatch for the allow-list, not a licence to drop the
        // Host header entirely.
        assert!(is_forbidden(check_host(&request(None), &policy, false)));
    }

    #[test]
    fn unparseable_allow_list_entries_are_dropped() {
        let policy = HostPolicy::parse_list(",, evil.com@127.0.0.1 ,http://ok.example:3000/path,");
        assert_eq!(
            policy.extra,
            vec![HostPattern {
                host: "ok.example".to_string(),
                port: Some(3000),
            }]
        );
    }

    #[test]
    fn default_guard_matches_the_documented_set() {
        // Smoke-test the public entry point. Skipped when the test process
        // itself sets the env var, since `allowed_hosts()` reads it once.
        if std::env::var_os(ALLOWED_HOSTS_ENV).is_some() {
            return;
        }
        for host in ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"] {
            let mut req = request(Some(host));
            assert!(validate_loopback_host(&mut req).is_ok(), "{host}");
        }
        for host in ["evil.com", "127.0.0.1.evil.com"] {
            let mut req = request(Some(host));
            assert!(is_forbidden(validate_loopback_host(&mut req)), "{host}");
        }
        // The preview proxy variant adds `*.localhost` and nothing else.
        let mut req = request(Some("3000.localhost:3003"));
        assert!(validate_preview_proxy_host(&mut req).is_ok());
        let mut req = request(Some("evil.com"));
        assert!(is_forbidden(validate_preview_proxy_host(&mut req)));
    }

    async fn body_text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// The guard's whole value rests on being attached to the *outermost*
    /// router, so exercise a router shaped like `crate::routes::router` end to
    /// end: nested API routes, the catch-all static route, the root, and the
    /// method-mismatch fallback must all be intercepted.
    #[tokio::test]
    async fn outer_layer_covers_nested_static_and_fallback_routes() {
        use axum::{Router, routing::get};
        use tower::ServiceExt;
        use tower_http::validate_request::ValidateRequestHeaderLayer;

        if std::env::var_os(ALLOWED_HOSTS_ENV).is_some() {
            return;
        }

        let app = || {
            Router::new()
                .route("/", get(|| async { "root" }))
                .route("/{*path}", get(|| async { "static" }))
                .nest(
                    "/api",
                    Router::new().route("/health", get(|| async { "ok" })),
                )
                .layer(ValidateRequestHeaderLayer::custom(validate_loopback_host))
        };

        let probes = [
            ("GET", "/"),
            ("GET", "/assets/index-abc123.js"),
            ("GET", "/api/health"),
            ("GET", "/does/not/exist"),
            // Method mismatch would normally be a 405 from the fallback; the
            // guard runs first.
            ("POST", "/"),
        ];

        for (method, path) in probes {
            let req = |host: &str| {
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header(header::HOST, host)
                    .body(Body::empty())
                    .unwrap()
            };
            let response = app().oneshot(req("evil.com")).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{method} {path} with a foreign Host"
            );

            let response = app().oneshot(req("127.0.0.1:3000")).await.unwrap();
            assert_ne!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{method} {path} with a loopback Host"
            );
        }
    }

    #[tokio::test]
    async fn forbidden_response_explains_the_rule_and_the_escape_hatch() {
        let Err(response) = check(Some("evil.com")) else {
            panic!("expected rejection");
        };
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain; charset=utf-8"
        );
        let body = body_text(response).await;
        assert!(body.contains("evil.com"), "{body}");
        assert!(body.contains("loopback"), "{body}");
        assert!(body.contains(ALLOWED_HOSTS_ENV), "{body}");
    }

    #[tokio::test]
    async fn forbidden_response_does_not_echo_unsafe_characters() {
        let Err(response) = check(Some("evil.com/<script>")) else {
            panic!("expected rejection");
        };
        let body = body_text(response).await;
        assert!(!body.contains('<'), "{body}");
        assert!(!body.contains("evil.com/"), "{body}");
        assert!(body.contains("evil.comscript"), "{body}");
    }
}
