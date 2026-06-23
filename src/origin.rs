//! origin — request guards for mobile-cc's `extra_api` routes.
//!
//! Two independent guards, both used by the push module (src/push.rs):
//!
//!   * `origin_guard` — an axum middleware that mirrors ttyview-core's
//!     WebSocket same-origin check (ws.rs `origin_allowed`). Browsers do NOT
//!     enforce same-origin on cross-site `fetch`/form POSTs reaching a
//!     credential-less local daemon, so a page the user visits could
//!     otherwise drive /api/push/*. We reject any request whose `Origin`
//!     authority doesn't match the request `Host`, AND — in strict mode, used
//!     for /api/push/* — any request with NO `Origin` at all. push has no
//!     legitimate non-browser caller, so this is intentionally stricter than
//!     the WS path (which allows Origin-less server clients like the sandbox
//!     spectator). `ttyview-core`'s `origin_allowed` is `pub(crate)`, so this
//!     is a faithful local copy rather than a re-export.
//!
//!   * `is_safe_push_endpoint` — an SSRF guard for the Web Push subscription
//!     endpoint. That URL is POSTed to FROM THE SERVER, so a malicious
//!     subscriber must not be able to aim it at loopback / private / tailnet
//!     hosts. We require https and a public host (IP literals in any
//!     non-global range are rejected, including the 100.64/10 CGNAT range
//!     Tailscale uses).

use std::net::IpAddr;

use axum::{
    extract::Request,
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

// ---- same-origin guard (mirrors ttyview-core ws.rs origin_allowed) -----

/// Extract the authority (host[:port]) from an Origin header value. Returns
/// None for non-http(s) origins.
fn origin_authority(origin: &str) -> Option<&str> {
    for scheme in ["http://", "https://"] {
        if let Some(rest) = origin.strip_prefix(scheme) {
            return Some(rest.split('/').next().unwrap_or(rest));
        }
    }
    None
}

/// True if the request should be accepted.
///   1. No / empty / "null" Origin → allow UNLESS `strict` (non-browser caller).
///      The WS path is non-strict; /api/push/* is strict (it has no legitimate
///      non-browser caller, so an Origin-less request is rejected).
///   2. Origin authority == Host → allow (same-origin).
///   3. Otherwise reject (cross-origin browser request).
pub fn origin_allowed(headers: &HeaderMap, strict: bool) -> bool {
    let origin = match headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        None => return !strict,
        Some(s) if s.is_empty() || s == "null" => return !strict,
        Some(s) => s,
    };
    if let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        if origin_authority(origin) == Some(host) {
            return true;
        }
    }
    false
}

/// axum middleware for /api/push/* — STRICT same-origin: rejects cross-origin
/// requests AND Origin-less ones. push has no legitimate non-browser caller, so
/// this is intentionally stricter than ttyview-core's WS check (which allows
/// Origin-less server clients like the sandbox spectator).
pub async fn origin_guard(req: Request, next: Next) -> Response {
    if origin_allowed(req.headers(), true) {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "origin not allowed").into_response()
    }
}

// ---- SSRF guard for push subscription endpoints ------------------------

/// True if `ip` is a globally-routable address we'd be willing to POST to.
/// Hand-rolled because `IpAddr::is_global` is still nightly-only.
fn is_global_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || o[0] == 0
                // CGNAT 100.64.0.0/10 — the range Tailscale hands out.
                || (o[0] == 100 && (o[1] & 0xc0) == 0x40))
        }
        IpAddr::V6(v6) => {
            // Unwrap v4-mapped (::ffff:a.b.c.d) so a private v4 can't be
            // smuggled through a v6 literal.
            if let Some(m) = v6.to_ipv4_mapped() {
                return is_global_ip(IpAddr::V4(m));
            }
            let o = v6.octets();
            !(v6.is_loopback()
                || v6.is_unspecified()
                // ULA fc00::/7
                || (o[0] & 0xfe) == 0xfc
                // link-local fe80::/10
                || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80))
        }
    }
}

/// SSRF guard for a Web Push subscription endpoint. Require https and a public
/// host; reject loopback/private/tailnet IPs and obvious local hostnames.
pub fn is_safe_push_endpoint(endpoint: &str) -> bool {
    let rest = match endpoint.strip_prefix("https://") {
        Some(r) => r,
        None => return false, // non-https (incl. http://) rejected outright
    };
    // Authority is everything before the first path / query / fragment.
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(rest);
    if authority.is_empty() || authority.contains('@') {
        // Empty, or userinfo present (push URLs never carry credentials and it
        // muddies host parsing) → reject.
        return false;
    }
    // Host, stripping an optional :port. Handle [v6]:port bracket form.
    let host = if let Some(after) = authority.strip_prefix('[') {
        match after.split(']').next() {
            Some(h) if !h.is_empty() => h,
            _ => return false,
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_global_ip(ip);
    }
    // Hostname: reject local-only suffixes and bare single labels.
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".localhost")
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
    {
        return false;
    }
    lower.contains('.') // require an FQDN-ish name, not a bare internal label
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        m
    }

    #[test]
    fn no_origin_strict_rejected_lenient_allowed() {
        let hm = h(&[("host", "x.ts.net")]);
        // strict (push) rejects an Origin-less request …
        assert!(!origin_allowed(&hm, true));
        // … while non-strict (the WS-mirror) allows it.
        assert!(origin_allowed(&hm, false));
        // "null"/empty Origin is opaque → same treatment as no Origin.
        let hm_null = h(&[("origin", "null"), ("host", "x.ts.net")]);
        assert!(!origin_allowed(&hm_null, true));
        assert!(origin_allowed(&hm_null, false));
    }

    #[test]
    fn same_origin_allowed_both_modes() {
        for strict in [true, false] {
            assert!(origin_allowed(
                &h(&[("origin", "https://x.ts.net"), ("host", "x.ts.net")]),
                strict
            ));
            assert!(origin_allowed(
                &h(&[("origin", "http://127.0.0.1:7800"), ("host", "127.0.0.1:7800")]),
                strict
            ));
        }
    }

    #[test]
    fn cross_origin_rejected_both_modes() {
        for strict in [true, false] {
            assert!(!origin_allowed(
                &h(&[("origin", "https://evil.example"), ("host", "x.ts.net")]),
                strict
            ));
        }
    }

    #[test]
    fn endpoint_safe_for_real_providers() {
        assert!(is_safe_push_endpoint(
            "https://fcm.googleapis.com/fcm/send/abc123"
        ));
        assert!(is_safe_push_endpoint(
            "https://updates.push.services.mozilla.com/wpush/v2/xyz"
        ));
        assert!(is_safe_push_endpoint("https://web.push.apple.com/QFoo"));
    }

    #[test]
    fn endpoint_rejects_ssrf_targets() {
        assert!(!is_safe_push_endpoint("http://fcm.googleapis.com/x")); // not https
        assert!(!is_safe_push_endpoint("https://127.0.0.1/x"));
        assert!(!is_safe_push_endpoint("https://[::1]/x"));
        assert!(!is_safe_push_endpoint("https://192.168.1.10/x"));
        assert!(!is_safe_push_endpoint("https://10.0.0.5/x"));
        assert!(!is_safe_push_endpoint("https://100.88.46.69/x")); // tailnet CGNAT
        assert!(!is_safe_push_endpoint("https://localhost/x"));
        assert!(!is_safe_push_endpoint("https://router/x")); // bare label
        assert!(!is_safe_push_endpoint("https://box.local/x"));
        assert!(!is_safe_push_endpoint("https://user@evil/x"));
        assert!(!is_safe_push_endpoint("https://[::ffff:127.0.0.1]/x")); // v4-mapped loopback
    }
}
