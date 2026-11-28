//! What a native App needs from the instance, over its public Connect API
//! with the app's session: the trust material
//! (`AppService.GetAppRuntimeTrust`) and the live signed package
//! (`AppService.GetAppPackage`, a server stream: a description, then the
//! bytes in chunks).

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Digest;
use std::time::Duration;

use super::package::RuntimeTrust;

/// Packages are small; a stalled download ends here.
const PACKAGE_TIMEOUT: Duration = Duration::from_secs(120);
/// The largest package accepted (the platform's are a few MB).
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

/// The description `GetAppPackage` sends first.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub app_id: String,
    pub deployment_id: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub build: u32,
    pub nsh_app_id: String,
    pub sha256: String,
    #[serde(default)]
    pub size: u32,
}

/// A failure, as the page shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchError {
    /// The platform's code (`APP_PACKAGE_UNAVAILABLE`, ...) or a Connect
    /// code.
    pub code: String,
    pub message: String,
}

impl FetchError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

fn network(error: reqwest::Error) -> FetchError {
    FetchError::new(
        "unavailable",
        format!("Could not reach the instance: {error}"),
    )
}

/// A Connect error body: `{ code, message, details }`; the platform's own
/// code rides in `message` or as a detail, so both are kept.
fn connect_error(status: u16, body: &Value) -> FetchError {
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or(if status == 401 {
            "unauthenticated"
        } else {
            "unknown"
        });
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The instance refused the request.");
    FetchError::new(code, message)
}

fn endpoint(origin: &str, method: &str) -> String {
    format!("{origin}/api/rpc/hatch.platform.v1.{method}")
}

pub async fn runtime_trust(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<RuntimeTrust, FetchError> {
    let response = http
        .post(endpoint(origin, "AppService/GetAppRuntimeTrust"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .bearer_auth(token)
        .body("{}")
        .send()
        .await
        .map_err(network)?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Err(connect_error(status, &body));
    }
    serde_json::from_value(body.get("trust").cloned().unwrap_or(Value::Null))
        .map_err(|e| FetchError::new("internal", format!("Unreadable trust answer: {e}")))
}

/// One Connect envelope: flags and its JSON.
fn envelope(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(0);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Splits a Connect stream's body into its messages; the end-of-stream
/// message (flag `0x02`) turns into an error when it carries one.
pub fn read_stream(body: &[u8]) -> Result<Vec<Value>, FetchError> {
    let mut messages = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        if rest.len() < 5 {
            return Err(FetchError::new(
                "internal",
                "The package stream was cut short.",
            ));
        }
        let flags = rest[0];
        let length = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        if rest.len() < 5 + length {
            return Err(FetchError::new(
                "internal",
                "The package stream was cut short.",
            ));
        }
        let value: Value = serde_json::from_slice(&rest[5..5 + length])
            .map_err(|e| FetchError::new("internal", format!("Unreadable package stream: {e}")))?;
        rest = &rest[5 + length..];
        if flags & 0x02 != 0 {
            if let Some(error) = value.get("error") {
                return Err(connect_error(0, error));
            }
            return Ok(messages);
        }
        messages.push(value);
    }
    Err(FetchError::new(
        "internal",
        "The package stream did not end.",
    ))
}

/// The package's description and bytes, checked against the description's
/// size and SHA-256 (a cut or mixed-up download never reaches the verifier
/// as a package).
pub fn assemble(messages: Vec<Value>) -> Result<(PackageInfo, Vec<u8>), FetchError> {
    let mut parts = messages.into_iter();
    let info: PackageInfo = parts
        .next()
        .and_then(|first| first.get("package").cloned())
        .and_then(|package| serde_json::from_value(package).ok())
        .ok_or_else(|| FetchError::new("internal", "The package stream had no description."))?;
    let mut bytes = Vec::with_capacity(info.size as usize);
    for part in parts {
        let chunk = part.get("chunk").and_then(Value::as_str).ok_or_else(|| {
            FetchError::new("internal", "The package stream sent something else.")
        })?;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(chunk)
            .map_err(|_| FetchError::new("internal", "A package chunk is not base64."))?;
        bytes.extend_from_slice(&decoded);
        if bytes.len() > MAX_PACKAGE_BYTES {
            return Err(FetchError::new(
                "resource_exhausted",
                "The package is too large.",
            ));
        }
    }
    let sha: String = sha2::Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if bytes.len() != info.size as usize || sha != info.sha256.to_ascii_lowercase() {
        return Err(FetchError::new(
            "data_loss",
            "The package did not arrive whole. Try again.",
        ));
    }
    Ok((info, bytes))
}

pub async fn app_package(
    http: &reqwest::Client,
    origin: &str,
    token: &str,
    app_id: &str,
) -> Result<(PackageInfo, Vec<u8>), FetchError> {
    let request = json!({ "id": app_id }).to_string();
    let response = http
        .post(endpoint(origin, "AppService/GetAppPackage"))
        .header("content-type", "application/connect+json")
        .header("connect-protocol-version", "1")
        .bearer_auth(token)
        .timeout(PACKAGE_TIMEOUT)
        .body(envelope(request.as_bytes()))
        .send()
        .await
        .map_err(network)?;
    let status = response.status().as_u16();
    let body = response.bytes().await.map_err(network)?;
    if !(200..300).contains(&status) {
        let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return Err(connect_error(status, &value));
    }
    let (info, bytes) = assemble(read_stream(&body)?)?;
    if info.app_id != app_id {
        return Err(FetchError::new(
            "internal",
            "The instance sent another App's package.",
        ));
    }
    Ok((info, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(error: Option<Value>) -> Vec<u8> {
        let body = match error {
            Some(error) => json!({ "error": error }),
            None => json!({}),
        };
        let payload = body.to_string();
        let mut out = vec![0x02];
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload.as_bytes());
        out
    }

    fn stream(bytes: &[u8], sha: &str, size: usize) -> Vec<u8> {
        let mut out = envelope(
            json!({ "package": { "appId": "a", "deploymentId": "d", "build": 2, "nshAppId": "dev.hatch.app.a", "sha256": sha, "size": size } })
                .to_string()
                .as_bytes(),
        );
        for chunk in bytes.chunks(3) {
            let encoded = base64::engine::general_purpose::STANDARD.encode(chunk);
            out.extend(envelope(json!({ "chunk": encoded }).to_string().as_bytes()));
        }
        out.extend(end(None));
        out
    }

    fn sha(bytes: &[u8]) -> String {
        sha2::Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn reassembles_a_streamed_package() {
        let package = b"nshpkg-bytes-for-test";
        let (info, bytes) =
            assemble(read_stream(&stream(package, &sha(package), package.len())).unwrap()).unwrap();
        assert_eq!(bytes, package);
        assert_eq!(info.build, 2);
    }

    #[test]
    fn refuses_a_package_that_does_not_match_its_description() {
        let package = b"nshpkg-bytes-for-test";
        let wrong = assemble(read_stream(&stream(package, &sha(b"other"), package.len())).unwrap());
        assert_eq!(wrong.unwrap_err().code, "data_loss");
        let short =
            assemble(read_stream(&stream(package, &sha(package), package.len() + 1)).unwrap());
        assert_eq!(short.unwrap_err().code, "data_loss");
        let mut cut = stream(package, &sha(package), package.len());
        cut.truncate(cut.len() - 3);
        assert!(read_stream(&cut).is_err());
    }

    #[test]
    fn reports_the_streams_error() {
        let body = end(Some(
            json!({ "code": "failed_precondition", "message": "APP_PACKAGE_UNAVAILABLE: deploy again" }),
        ));
        let error = read_stream(&body).unwrap_err();
        assert_eq!(error.code, "failed_precondition");
        assert!(error.message.contains("APP_PACKAGE_UNAVAILABLE"));
    }
}
