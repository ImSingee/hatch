//! The host side of a native App's bridge (`host.call`): the same calls and
//! answers as the web player's host (`sdk-internal/app/src/native-player.ts`,
//! `docs/app-native-runtime.md` "Host bridge").
//!
//! Every call is checked here before anything is sent, and every request is
//! scoped to the App the session was opened for: its id and deployment are
//! bound when the session starts and never read from a call's arguments.
//! `hatch.rpc` reaches only `/api/app/<id>/rpc/<service>/<method>` and the
//! data calls only `/api/app/<id>/data/*`, all on the signed-in instance with
//! the app's own session. Every answer is an envelope (`{ ok: true, ... }` or
//! `{ ok: false, code, message }`): a rejected host call would reach the App
//! with its message only.

use serde_json::{json, Map, Value};
use std::time::Duration;

/// How long one `hatch.data.events` call waits before answering "none".
pub const DATA_EVENTS_WAIT: Duration = Duration::from_secs(25);
const MAX_ROUTE_LENGTH: usize = 4_096;
const MAX_TITLE_LENGTH: usize = 256;
/// Hatch App ids and slugs: `[a-z0-9]` then `[a-z0-9-]`, at most 64.
const MAX_SLUG_LENGTH: usize = 64;
const DATA_DEPLOYMENT_HEADER: &str = "x-hatch-data-deployment";

/// The App a session runs: what every request of its bridge is scoped to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppScope {
    pub app_id: String,
    pub deployment_id: String,
}

/// An answer that never reached the network.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn envelope(&self) -> Value {
        json!({ "ok": false, "code": self.code, "message": self.message })
    }
}

/// What the shell around the App does for a navigation call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellRequest {
    SetTitle(Option<String>),
    SetRoute(String),
    Open { slug: String, route: String },
}

/// Which instance endpoint a request goes to, which decides how its answer
/// is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Rpc,
    DataQuery,
    DataMutate,
    DataEvents,
}

/// A request to the instance, relative to its origin.
#[derive(Debug, Clone, PartialEq)]
pub struct InstanceRequest {
    pub endpoint: Endpoint,
    pub method: &'static str,
    /// Path and query, starting with `/api/app/<id>/`.
    pub path: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
}

/// What a call needs.
#[derive(Debug, Clone, PartialEq)]
pub enum Planned {
    /// Answered at once with this envelope.
    Answer(Value),
    /// The current theme (`hatch.theme.get`).
    Theme,
    /// The shell acts, then answers `{ ok: true }`.
    Shell(ShellRequest),
    /// A request to the instance.
    Instance(InstanceRequest),
}

fn is_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A protobuf service's full name: dot-separated identifiers.
fn is_service_name(value: &str) -> bool {
    !value.is_empty() && value.split('.').all(is_identifier)
}

/// `[a-z0-9][a-z0-9-]{0,63}`, as `APP_SLUG_RE` in `@hatch/manifest`.
fn is_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_SLUG_LENGTH
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A Hatch record id: `[a-z0-9]` then `[a-z0-9-]`, at most 191 (the API's
/// limit for ids).
fn is_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 191
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Percent-encodes a query value (RFC 3986 unreserved characters stay).
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

impl AppScope {
    /// Hatch ids are `[a-z0-9-]`; anything else could leave the App's path.
    pub fn new(app_id: &str, deployment_id: &str) -> Option<Self> {
        (is_id(app_id) && is_id(deployment_id)).then(|| Self {
            app_id: app_id.to_owned(),
            deployment_id: deployment_id.to_owned(),
        })
    }

    fn base(&self) -> String {
        format!("/api/app/{}", self.app_id)
    }

    /// Checks call `name` with `args` and says what answers it.
    pub fn plan(&self, name: &str, args: &Value) -> Result<Planned, Refusal> {
        let empty = Map::new();
        let input = match args {
            Value::Null => &empty,
            Value::Object(map) => map,
            _ => {
                return Err(Refusal::new(
                    "invalid_argument",
                    format!("{name} takes an object."),
                ))
            }
        };
        match name {
            "hatch.rpc" => self.rpc(input),
            "hatch.data.query" => self.data(Endpoint::DataQuery, "query", input),
            "hatch.data.mutate" => self.data(Endpoint::DataMutate, "mutate", input),
            "hatch.data.events" => self.events(input),
            "hatch.theme.get" => Ok(Planned::Theme),
            "hatch.nav.setTitle" => match input.get("title") {
                Some(Value::Null) => Ok(Planned::Shell(ShellRequest::SetTitle(None))),
                Some(Value::String(title)) if title.chars().count() <= MAX_TITLE_LENGTH => {
                    Ok(Planned::Shell(ShellRequest::SetTitle(
                        (!title.is_empty()).then(|| title.clone()),
                    )))
                }
                _ => Err(Refusal::new(
                    "invalid_argument",
                    format!("hatch.nav.setTitle needs {{ title }} (a string of at most {MAX_TITLE_LENGTH} characters, or null)."),
                )),
            },
            "hatch.nav.setRoute" => match input.get("route") {
                Some(Value::String(route))
                    if route.chars().count() <= MAX_ROUTE_LENGTH && !route.starts_with('#') =>
                {
                    Ok(Planned::Shell(ShellRequest::SetRoute(route.clone())))
                }
                _ => Err(Refusal::new(
                    "invalid_argument",
                    "hatch.nav.setRoute needs { route }: a fragment without \"#\".",
                )),
            },
            "hatch.nav.open" => {
                let slug = input.get("slug");
                let route = input.get("route").unwrap_or(&Value::Null);
                match (slug, route) {
                    (Some(Value::String(slug)), Value::Null) if is_slug(slug) => {
                        Ok(Planned::Shell(ShellRequest::Open {
                            slug: slug.clone(),
                            route: String::new(),
                        }))
                    }
                    (Some(Value::String(slug)), Value::String(route))
                        if is_slug(slug) && route.chars().count() <= MAX_ROUTE_LENGTH =>
                    {
                        Ok(Planned::Shell(ShellRequest::Open {
                            slug: slug.clone(),
                            route: route.clone(),
                        }))
                    }
                    _ => Err(Refusal::new(
                        "invalid_argument",
                        "hatch.nav.open needs { slug, route? }.",
                    )),
                }
            }
            // No native capability is granted on this shell yet.
            "hatch.native.supports" => Ok(Planned::Answer(json!({ "ok": true, "capabilities": [] }))),
            _ => Err(Refusal::new(
                "unimplemented",
                format!("{name} is not a host function."),
            )),
        }
    }

    fn rpc(&self, input: &Map<String, Value>) -> Result<Planned, Refusal> {
        let invalid = || {
            Refusal::new(
                "invalid_argument",
                "hatch.rpc needs { service, method, message }.",
            )
        };
        let service = input
            .get("service")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let method = input
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        // Any JSON value: a message's JSON form need not be an object
        // (`google.protobuf.Value`, wrappers). The backend checks its shape.
        let message = input.get("message").ok_or_else(invalid)?;
        if !is_service_name(service) || !is_identifier(method) {
            return Err(invalid());
        }
        Ok(Planned::Instance(InstanceRequest {
            endpoint: Endpoint::Rpc,
            method: "POST",
            path: format!("{}/rpc/{service}/{method}", self.base()),
            headers: vec![
                ("content-type", "application/json".into()),
                ("connect-protocol-version", "1".into()),
            ],
            body: Some(message.to_string()),
        }))
    }

    fn data(
        &self,
        endpoint: Endpoint,
        action: &str,
        input: &Map<String, Value>,
    ) -> Result<Planned, Refusal> {
        let body = match input.get("body") {
            Some(body @ Value::Object(_)) => body,
            _ => {
                return Err(Refusal::new(
                    "invalid_argument",
                    format!("hatch.data.{action} needs {{ body }}."),
                ))
            }
        };
        Ok(Planned::Instance(InstanceRequest {
            endpoint,
            method: "POST",
            path: format!("{}/data/{action}", self.base()),
            headers: vec![
                ("content-type", "application/json".into()),
                (DATA_DEPLOYMENT_HEADER, self.deployment_id.clone()),
            ],
            body: Some(body.to_string()),
        }))
    }

    fn events(&self, input: &Map<String, Value>) -> Result<Planned, Refusal> {
        let table = input.get("table").and_then(Value::as_str);
        let since = input.get("since").and_then(Value::as_i64);
        let safe = |n: i64| (0..=9_007_199_254_740_991).contains(&n);
        match (table, since) {
            (Some(table), Some(since))
                if !table.is_empty()
                    && safe(since)
                    && input.get("since").is_some_and(|v| v.is_i64() || v.is_u64()) =>
            {
                Ok(Planned::Instance(InstanceRequest {
                    endpoint: Endpoint::DataEvents,
                    method: "GET",
                    path: format!(
                        "{}/data/events?since={since}&table={}",
                        self.base(),
                        encode_component(table)
                    ),
                    headers: vec![(DATA_DEPLOYMENT_HEADER, self.deployment_id.clone())],
                    body: None,
                }))
            }
            _ => Err(Refusal::new(
                "invalid_argument",
                "hatch.data.events needs { table, since }.",
            )),
        }
    }
}

/// Connect code for an HTTP status the Data API answered with.
pub fn code_for_status(status: u16) -> &'static str {
    match status {
        400 => "invalid_argument",
        401 => "unauthenticated",
        403 => "permission_denied",
        404 => "not_found",
        409 => "already_exists",
        429 => "resource_exhausted",
        503 => "unavailable",
        504 => "deadline_exceeded",
        s if s >= 500 => "internal",
        _ => "unknown",
    }
}

/// The envelope for an instance's answer to `request`.
pub fn answer(endpoint: Endpoint, status: u16, headers: &[(String, String)], text: &str) -> Value {
    let ok = (200..300).contains(&status);
    match endpoint {
        Endpoint::Rpc => {
            let parsed: Option<Value> = if text.is_empty() {
                Some(json!({}))
            } else {
                serde_json::from_str(text).ok()
            };
            if !ok {
                let failure = parsed.as_ref().and_then(Value::as_object);
                let code = failure
                    .and_then(|f| f.get("code"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| code_for_status(status).to_owned());
                let message = failure
                    .and_then(|f| f.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("HTTP {status}"));
                return json!({ "ok": false, "code": code, "message": message });
            }
            match parsed {
                Some(message) => {
                    let header: Map<String, Value> = headers
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect();
                    json!({ "ok": true, "message": message, "header": header })
                }
                None => Refusal::new("internal", "The backend answered with no JSON message.")
                    .envelope(),
            }
        }
        Endpoint::DataQuery | Endpoint::DataMutate => {
            if !ok {
                let message = if text.is_empty() {
                    format!("HTTP {status}")
                } else {
                    text.to_owned()
                };
                return json!({ "ok": false, "code": code_for_status(status), "message": message });
            }
            match serde_json::from_str::<Value>(text) {
                Ok(result) => json!({ "ok": true, "result": result }),
                Err(_) => {
                    Refusal::new("internal", "The Data API answered with no JSON.").envelope()
                }
            }
        }
        Endpoint::DataEvents => {
            if !ok {
                let message = if text.is_empty() {
                    format!("HTTP {status}")
                } else {
                    text.to_owned()
                };
                return json!({ "ok": false, "code": code_for_status(status), "message": message });
            }
            json!({ "ok": true, "events": parse_events(text) })
        }
    }
}

/// The change events in a server-sent event stream's text:
/// `[{ revision?, reset }]`.
pub fn parse_events(text: &str) -> Vec<Value> {
    let mut found = Vec::new();
    for block in text.split("\n\n") {
        let mut kind = None;
        let mut id = None;
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("event:") {
                kind = Some(rest.trim().to_owned());
            } else if let Some(rest) = line.strip_prefix("id:") {
                id = rest.trim().parse::<u64>().ok();
            }
        }
        let Some(kind) = kind else { continue };
        let mut event = Map::new();
        if let Some(id) = id.filter(|id| *id <= 9_007_199_254_740_991) {
            event.insert("revision".into(), json!(id));
        }
        event.insert("reset".into(), json!(kind == "reset"));
        found.push(Value::Object(event));
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> AppScope {
        AppScope::new("01m8f6110hdf7rm7hbgrh239ae", "01m8f614x5k3kz5pm9xfydbvnf").unwrap()
    }

    fn refused(name: &str, args: Value) -> Refusal {
        scope().plan(name, &args).expect_err(name)
    }

    fn instance(name: &str, args: Value) -> InstanceRequest {
        match scope().plan(name, &args).expect(name) {
            Planned::Instance(request) => request,
            other => panic!("{name}: {other:?}"),
        }
    }

    #[test]
    fn rpc_reaches_only_the_apps_own_backend() {
        let request = instance(
            "hatch.rpc",
            json!({ "service": "counter.v1.CounterService", "method": "Increment", "message": { "amount": 1 } }),
        );
        assert_eq!(
            request.path,
            "/api/app/01m8f6110hdf7rm7hbgrh239ae/rpc/counter.v1.CounterService/Increment"
        );
        assert_eq!(request.body.as_deref(), Some(r#"{"amount":1}"#));
        // A message need not be an object.
        instance(
            "hatch.rpc",
            json!({ "service": "a.B", "method": "C", "message": 3 }),
        );
    }

    #[test]
    fn rpc_names_cannot_leave_the_apps_path() {
        for (service, method) in [
            ("../other", "Call"),
            ("a.B/../../x", "C"),
            ("a.B", "C/D"),
            ("a..B", "C"),
            ("a.B", "../../../api/rpc"),
            ("", "C"),
            ("a.B", ""),
            ("1a.B", "C"),
            ("a.B", "C?x=1"),
            ("a.B%2F", "C"),
        ] {
            let refusal = refused(
                "hatch.rpc",
                json!({ "service": service, "method": method, "message": {} }),
            );
            assert_eq!(refusal.code, "invalid_argument", "{service}/{method}");
        }
        // The App's id comes from the session, never from the call.
        let request = instance(
            "hatch.rpc",
            json!({ "service": "a.B", "method": "C", "message": {}, "appId": "other", "app": "other" }),
        );
        assert!(request
            .path
            .starts_with("/api/app/01m8f6110hdf7rm7hbgrh239ae/rpc/"));
    }

    #[test]
    fn rpc_needs_every_field() {
        for args in [
            json!({}),
            json!({ "service": "a.B", "method": "C" }),
            json!({ "service": 1, "method": "C", "message": {} }),
            json!({ "service": "a.B", "method": ["C"], "message": {} }),
            json!("hatch.rpc"),
            json!([1, 2]),
        ] {
            assert_eq!(
                refused("hatch.rpc", args.clone()).code,
                "invalid_argument",
                "{args}"
            );
        }
    }

    #[test]
    fn data_calls_are_scoped_to_the_app_and_its_deployment() {
        let query = instance("hatch.data.query", json!({ "body": { "table": "notes" } }));
        assert_eq!(query.path, "/api/app/01m8f6110hdf7rm7hbgrh239ae/data/query");
        assert!(query.headers.contains(&(
            "x-hatch-data-deployment",
            "01m8f614x5k3kz5pm9xfydbvnf".into()
        )));
        let mutate = instance("hatch.data.mutate", json!({ "body": { "operations": [] } }));
        assert_eq!(
            mutate.path,
            "/api/app/01m8f6110hdf7rm7hbgrh239ae/data/mutate"
        );
        let events = instance(
            "hatch.data.events",
            json!({ "table": "notes/../x&y=1", "since": 4 }),
        );
        assert_eq!(
            events.path,
            "/api/app/01m8f6110hdf7rm7hbgrh239ae/data/events?since=4&table=notes%2F..%2Fx%26y%3D1"
        );
        for (name, args) in [
            ("hatch.data.query", json!({})),
            ("hatch.data.query", json!({ "body": "select" })),
            ("hatch.data.mutate", json!({ "body": [] })),
            ("hatch.data.events", json!({ "table": "", "since": 0 })),
            ("hatch.data.events", json!({ "table": "t", "since": -1 })),
            ("hatch.data.events", json!({ "table": "t", "since": 1.5 })),
            ("hatch.data.events", json!({ "table": "t", "since": "1" })),
            (
                "hatch.data.events",
                json!({ "table": "t", "since": 9_007_199_254_740_992u64 }),
            ),
        ] {
            assert_eq!(
                refused(name, args.clone()).code,
                "invalid_argument",
                "{name} {args}"
            );
        }
    }

    #[test]
    fn navigation_calls_are_checked() {
        assert_eq!(
            scope().plan("hatch.nav.setTitle", &json!({ "title": "Notes" })),
            Ok(Planned::Shell(ShellRequest::SetTitle(Some("Notes".into()))))
        );
        assert_eq!(
            scope().plan("hatch.nav.setTitle", &json!({ "title": null })),
            Ok(Planned::Shell(ShellRequest::SetTitle(None)))
        );
        assert_eq!(
            scope().plan("hatch.nav.open", &json!({ "slug": "trail-log" })),
            Ok(Planned::Shell(ShellRequest::Open {
                slug: "trail-log".into(),
                route: String::new()
            }))
        );
        for (name, args) in [
            ("hatch.nav.setTitle", json!({})),
            ("hatch.nav.setTitle", json!({ "title": "x".repeat(257) })),
            ("hatch.nav.setRoute", json!({ "route": "#/notes" })),
            ("hatch.nav.setRoute", json!({ "route": "x".repeat(4097) })),
            ("hatch.nav.setRoute", json!({ "route": 3 })),
            ("hatch.nav.open", json!({ "slug": "../settings" })),
            ("hatch.nav.open", json!({ "slug": "Trail" })),
            ("hatch.nav.open", json!({ "slug": "-trail" })),
            ("hatch.nav.open", json!({ "slug": "a".repeat(65) })),
            ("hatch.nav.open", json!({ "slug": "trail", "route": 1 })),
        ] {
            assert_eq!(
                refused(name, args.clone()).code,
                "invalid_argument",
                "{name} {args}"
            );
        }
    }

    #[test]
    fn unknown_names_are_not_host_functions() {
        for name in [
            "hatch.fetch",
            "hatch.native.camera.take",
            "hatch.rpc.stream",
            "fetch",
        ] {
            assert_eq!(refused(name, json!({})).code, "unimplemented", "{name}");
        }
    }

    #[test]
    fn scopes_need_hatch_ids() {
        assert!(AppScope::new("../x", "d").is_none());
        assert!(AppScope::new("a/b", "d").is_none());
        assert!(AppScope::new("app", "").is_none());
        assert!(AppScope::new("app", "d/../x").is_none());
        assert!(AppScope::new("App", "d").is_none());
    }

    #[test]
    fn answers_are_envelopes() {
        assert_eq!(
            answer(
                Endpoint::Rpc,
                200,
                &[("x-a".into(), "1".into())],
                r#"{"count":2}"#
            ),
            json!({ "ok": true, "message": { "count": 2 }, "header": { "x-a": "1" } })
        );
        assert_eq!(
            answer(
                Endpoint::Rpc,
                400,
                &[],
                r#"{"code":"invalid_argument","message":"amount must be positive"}"#
            ),
            json!({ "ok": false, "code": "invalid_argument", "message": "amount must be positive" })
        );
        assert_eq!(
            answer(Endpoint::Rpc, 502, &[], "<html>bad gateway</html>"),
            json!({ "ok": false, "code": "internal", "message": "HTTP 502" })
        );
        assert_eq!(
            answer(Endpoint::DataQuery, 409, &[], "stale"),
            json!({ "ok": false, "code": "already_exists", "message": "stale" })
        );
        assert_eq!(
            answer(
                Endpoint::DataEvents,
                200,
                &[],
                "event: change\nid: 7\ndata: {}\n\nevent: reset\ndata: {}\n\n"
            ),
            json!({ "ok": true, "events": [{ "revision": 7, "reset": false }, { "reset": true }] })
        );
    }
}
