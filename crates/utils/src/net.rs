//! Small networking helpers shared by the local clients (TUI, Telegram bridge,
//! MCP server) that dial the backend over HTTP.

/// Turn a *bind* address into a host a client on the same machine can dial.
///
/// `HOST` names the address the server binds to, so the unspecified addresses
/// (`0.0.0.0`, `::`) mean "every interface". They are not a meaningful
/// destination, and the server's loopback-Host guard
/// (`server::middleware::origin`) rejects them as a `Host` header value —
/// a request to `http://0.0.0.0:3000` would come back `403 Forbidden`. Map
/// them onto loopback and pass everything else through unchanged.
pub fn dialable_host(host: &str) -> &str {
    match host.trim() {
        "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" | "0:0:0:0:0:0:0:0" => "[::1]",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_bind_addresses_map_to_loopback() {
        assert_eq!(dialable_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(dialable_host("::"), "[::1]");
        assert_eq!(dialable_host("[::]"), "[::1]");
        assert_eq!(dialable_host("0:0:0:0:0:0:0:0"), "[::1]");
    }

    #[test]
    fn other_hosts_pass_through() {
        assert_eq!(dialable_host("127.0.0.1"), "127.0.0.1");
        assert_eq!(dialable_host("localhost"), "localhost");
        assert_eq!(dialable_host("192.168.1.50"), "192.168.1.50");
        assert_eq!(dialable_host(" localhost "), "localhost");
    }
}
