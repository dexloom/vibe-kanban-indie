use std::{
    net::IpAddr,
    sync::{OnceLock, RwLock},
};

use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, header},
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
