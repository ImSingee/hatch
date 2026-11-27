//! What a native App may do in this app: the host calls of its bridge, and
//! nothing else.
//!
//! NSH treats a missing grant as "whatever the App declared", so the grant
//! is always given explicitly: an App whose package declared the network,
//! the clipboard, files or URLs still gets none of them here.

use nsh_engine::{parse_capabilities, Policy};

/// The host calls a native App may make: the platform's list
/// (`NATIVE_HOST_CALLS` in `src/server/apps/native/nsh-config.ts`), the same
/// on every shell. Exact names, no prefixes.
pub const HOST_CALLS: [&str; 9] = [
    "hatch.rpc",
    "hatch.data.query",
    "hatch.data.mutate",
    "hatch.data.events",
    "hatch.theme.get",
    "hatch.nav.setTitle",
    "hatch.nav.setRoute",
    "hatch.nav.open",
    "hatch.native.supports",
];

/// The grant as NSH's capabilities JSON: `{ "host": [...] }`, every other
/// capability denied.
pub fn grant_json() -> String {
    serde_json::json!({ "host": HOST_CALLS }).to_string()
}

/// The policy a verified package runs under: what it declared (from its
/// signed capabilities), at most the grant.
pub fn policy(declared: Policy) -> Policy {
    let granted = parse_capabilities(&grant_json()).expect("the grant parses");
    Policy {
        granted: Some(granted),
        ..declared
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What an App could declare at most: every capability NSH knows.
    fn greedy_declaration() -> Policy {
        let declared = parse_capabilities(
            r#"{
                "network": { "hosts": ["*"], "http": ["*"] },
                "fs": { "read": ["*"], "write": ["*"] },
                "clipboard": true,
                "picker": true,
                "share": true,
                "notifications": true,
                "statusBar": true,
                "openUrl": true,
                "webview": ["*"],
                "host": ["*"]
            }"#,
        )
        .expect("declaration parses");
        Policy {
            declared: Some(declared),
            ..Policy::default()
        }
    }

    #[test]
    fn grants_exactly_the_bridge() {
        let access = policy(greedy_declaration()).access();
        for name in HOST_CALLS {
            assert!(access.allows_host(name), "{name} should be granted");
        }
        for name in [
            "hatch.native.camera.take",
            "hatch.rpcx",
            "hatch.data",
            "hatch.data.query.more",
            "hatch.theme.set",
            "other.call",
        ] {
            assert!(!access.allows_host(name), "{name} must not be granted");
        }
    }

    #[test]
    fn denies_everything_a_package_declares_beyond_the_bridge() {
        let access = policy(greedy_declaration()).access();
        assert!(!access.allows_http("GET", "https://example.com/"));
        assert!(!access.allows_http("POST", "http://localhost:3000/api/rpc"));
        assert!(!access.allows_websocket("wss://example.com/"));
        assert!(!access.allows_clipboard());
        assert!(!access.allows_picker());
        assert!(!access.allows_share());
        assert!(!access.allows_notifications());
        assert!(!access.allows_open_url("https://example.com/"));
        assert!(!access.allows_open_url("mailto:someone@example.com"));
        assert!(!access.allows_webviews());
        assert!(!access.allows_home_dir());
    }

    #[test]
    fn an_undeclared_package_gets_nothing() {
        // No declaration at all: without the grant NSH would give every
        // capability but host calls, which always need a declaration.
        let access = policy(Policy::default()).access();
        assert!(!access.allows_host("hatch.rpc"));
        assert!(!access.allows_http("GET", "https://example.com/"));
        assert!(!access.allows_clipboard());
        assert!(!access.allows_open_url("https://example.com/"));
    }

    #[test]
    fn the_grant_cannot_widen_a_narrow_declaration() {
        let declared = parse_capabilities(r#"{ "host": ["hatch.rpc"] }"#).unwrap();
        let access = policy(Policy {
            declared: Some(declared),
            ..Policy::default()
        })
        .access();
        assert!(access.allows_host("hatch.rpc"));
        assert!(!access.allows_host("hatch.data.query"));
    }
}
