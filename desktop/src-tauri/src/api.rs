//! Calls the app makes to the instance itself: public Connect RPCs with the
//! session as `Authorization: Bearer`, and Better Auth's device login. The
//! token never leaves this module except into the Keychain.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

/// Device-login client the approval page names ("Approve Hatch for Mac?").
pub const DEVICE_CLIENT_ID: &str = "hatch-desktop";
const HANDOFF_CONSUME_PATH: &str = "/api/auth/handoffs/consume";
const HANDOFF_COMPLETION_PATH: &str = "/api/auth/handoffs/complete";
const DEVICE_VERIFICATION_PATH: &str = "/cli/authorize";

#[derive(Debug)]
pub enum ApiError {
    /// The session is gone (401): sign in again.
    Unauthorized,
    /// The address answers, but not as a Hatch instance.
    NotHatch,
    /// No answer, or an answer this app cannot use.
    Failed(String),
}

impl ApiError {
    pub fn message(&self) -> String {
        match self {
            Self::Unauthorized => "Your session has ended. Sign in again.".into(),
            Self::NotHatch => "That address does not answer as a Hatch instance.".into(),
            Self::Failed(message) => message.clone(),
        }
    }
}

pub struct Instance<'a> {
    pub http: &'a reqwest::Client,
    pub origin: &'a str,
}

pub fn client(user_agent: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(Duration::from_secs(15))
        // Every call names a fixed endpoint; a redirect elsewhere is refused.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client")
}

#[derive(Debug, Clone)]
pub struct Handoff {
    pub url: Url,
    pub ticket: String,
    pub completion_url: Url,
}

#[derive(Debug, Clone)]
pub struct DeviceGrant {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: Url,
    pub expires_in: Duration,
    pub interval: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DevicePoll {
    Pending,
    SlowDown,
    /// No usable answer (network, a 5xx, an unreadable body): ask again at
    /// the next interval. Only the grant's own answers end a sign-in.
    Unavailable,
    Approved(String),
    Denied,
    Expired,
}

fn network(error: reqwest::Error) -> ApiError {
    ApiError::Failed(if error.is_timeout() {
        "The instance did not answer in time.".into()
    } else {
        "Could not reach the instance. Check the address and your network.".into()
    })
}

/// A token Better Auth issued: printable ASCII, bounded.
pub fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 8192 && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn fixed_url(origin: &str, value: &str, path: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    (url.origin().ascii_serialization() == origin
        && url.path() == path
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

impl Instance<'_> {
    async fn rpc(&self, method: &str, token: Option<&str>, body: Value) -> Result<Value, ApiError> {
        let mut request = self
            .http
            .post(format!(
                "{}/api/rpc/hatch.platform.v1.{method}",
                self.origin
            ))
            .header("Content-Type", "application/json")
            .header("Connect-Protocol-Version", "1")
            .json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(network)?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status == 401 {
            return Err(ApiError::Unauthorized);
        }
        if !status.is_success() {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The instance refused the request.");
            return Err(ApiError::Failed(message.to_owned()));
        }
        Ok(value)
    }

    /// Whether the address is a Hatch instance: its public API answers an
    /// anonymous status request with Connect's `unauthenticated`.
    pub async fn probe(&self) -> Result<(), ApiError> {
        let response = self
            .http
            .post(format!(
                "{}/api/rpc/hatch.platform.v1.AuthService/GetStatus",
                self.origin
            ))
            .header("Content-Type", "application/json")
            .header("Connect-Protocol-Version", "1")
            .body("{}")
            .send()
            .await
            .map_err(network)?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status == 401 && value.get("code").and_then(Value::as_str) == Some("unauthenticated") {
            Ok(())
        } else {
            Err(ApiError::NotHatch)
        }
    }

    /// The signed-in user's display name, proving the session is live.
    pub async fn status(&self, token: &str) -> Result<String, ApiError> {
        let value = self
            .rpc("AuthService/GetStatus", Some(token), json!({}))
            .await?;
        let user = value
            .pointer("/session/user")
            .ok_or_else(|| ApiError::Failed("This credential is not a sign-in session.".into()))?;
        let name = user.get("name").and_then(Value::as_str).unwrap_or_default();
        let email = user
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default();
        Ok(if name.is_empty() { email } else { name }.to_owned())
    }

    /// A one-use ticket that signs the window's browser session in.
    pub async fn handoff(&self, token: &str) -> Result<Handoff, ApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            url: String,
            ticket: String,
            completion_url: String,
        }
        let value = self
            .rpc("AuthService/CreateHandoff", Some(token), json!({}))
            .await?;
        let response: Response = serde_json::from_value(value).map_err(|_| {
            ApiError::Failed("The instance returned an invalid sign-in ticket.".into())
        })?;
        let invalid =
            || ApiError::Failed("The sign-in ticket does not match this instance.".into());
        let url =
            fixed_url(self.origin, &response.url, HANDOFF_CONSUME_PATH).ok_or_else(invalid)?;
        let completion_url = fixed_url(
            self.origin,
            &response.completion_url,
            HANDOFF_COMPLETION_PATH,
        )
        .ok_or_else(invalid)?;
        let ticket_ok = (20..=512).contains(&response.ticket.len())
            && response
                .ticket
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !ticket_ok {
            return Err(invalid());
        }
        Ok(Handoff {
            url,
            ticket: response.ticket,
            completion_url,
        })
    }

    /// The instance's accent colour as `#RRGGBB`.
    pub async fn accent(&self, token: &str) -> Result<Option<String>, ApiError> {
        let value = self
            .rpc("ThemeService/GetTheme", Some(token), json!({}))
            .await?;
        let theme = value.get("theme").cloned().unwrap_or(Value::Null);
        let chosen = theme
            .get("accent")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .or_else(|| theme.get("defaultAccent").and_then(Value::as_str));
        let color = theme
            .get("accents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|accent| accent.get("name").and_then(Value::as_str) == chosen)
            .and_then(|accent| accent.get("color").and_then(Value::as_str))
            .filter(|color| {
                color.len() == 7
                    && color.starts_with('#')
                    && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
            })
            .map(str::to_owned);
        Ok(color)
    }

    /// Ends the session on the instance, for the window and for this app.
    pub async fn sign_out(&self, token: &str) -> Result<(), ApiError> {
        let response = self
            .http
            .post(format!("{}/api/auth/sign-out", self.origin))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .map_err(network)?;
        match response.status().as_u16() {
            200..=299 | 401 => Ok(()),
            status => Err(ApiError::Failed(format!("Sign-out failed ({status})."))),
        }
    }

    /// Starts a device login: the person approves it in their browser.
    pub async fn device_code(&self) -> Result<DeviceGrant, ApiError> {
        let response = self
            .http
            .post(format!("{}/api/auth/device/code", self.origin))
            .json(&json!({ "client_id": DEVICE_CLIENT_ID }))
            .send()
            .await
            .map_err(network)?;
        let ok = response.status().is_success();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        let invalid =
            || ApiError::Failed("The instance refused to start a browser sign-in.".into());
        if !ok {
            return Err(invalid());
        }
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        let device_code = text("device_code").filter(|v| !v.is_empty() && v.len() <= 8192);
        let user_code = text("user_code").filter(|v| {
            (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
        let expires_in = value
            .get("expires_in")
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0);
        let interval = value
            .get("interval")
            .and_then(Value::as_f64)
            .unwrap_or(5.0)
            .max(1.0);
        let (Some(device_code), Some(user_code), Some(expires_in)) =
            (device_code, user_code, expires_in)
        else {
            return Err(invalid());
        };
        let verification_url = text("verification_uri_complete")
            .and_then(|raw| Url::parse(raw).ok())
            .filter(|url| {
                url.origin().ascii_serialization() == self.origin
                    && url.path() == DEVICE_VERIFICATION_PATH
                    && url.fragment().is_none()
                    && url.username().is_empty()
                    && url.query_pairs().count() == 1
                    && url
                        .query_pairs()
                        .all(|(key, value)| key == "user_code" && value == user_code)
            })
            .ok_or_else(invalid)?;
        Ok(DeviceGrant {
            device_code: device_code.to_owned(),
            user_code: user_code.to_owned(),
            verification_url,
            expires_in: Duration::from_secs_f64(expires_in.min(1800.0)),
            interval: Duration::from_secs_f64(interval.min(60.0)),
        })
    }

    pub async fn device_poll(&self, device_code: &str) -> Result<DevicePoll, ApiError> {
        let sent = self
            .http
            .post(format!("{}/api/auth/device/token", self.origin))
            .json(&json!({
                "client_id": DEVICE_CLIENT_ID,
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            }))
            .send()
            .await;
        let Ok(response) = sent else {
            return Ok(DevicePoll::Unavailable);
        };
        let status = response.status().as_u16();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        classify_poll(status, &value)
    }
}

/// Reads one answer of Better Auth's device token endpoint (RFC 8628).
fn classify_poll(status: u16, value: &Value) -> Result<DevicePoll, ApiError> {
    if let Some(token) = value.get("access_token").and_then(Value::as_str) {
        return if valid_token(token) {
            Ok(DevicePoll::Approved(token.to_owned()))
        } else {
            Err(ApiError::Failed(
                "The instance returned an invalid session.".into(),
            ))
        };
    }
    Ok(match value.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => DevicePoll::Pending,
        Some("slow_down") => DevicePoll::SlowDown,
        Some("access_denied") => DevicePoll::Denied,
        Some("expired_token") => DevicePoll::Expired,
        _ if status == 429 => DevicePoll::SlowDown,
        _ if status >= 500 || value.is_null() => DevicePoll::Unavailable,
        _ => {
            return Err(ApiError::Failed(
                "Browser sign-in failed. Start again.".into(),
            ));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_urls_must_be_the_fixed_instance_endpoints() {
        let origin = "https://hatch.example.com";
        assert!(fixed_url(
            origin,
            "https://hatch.example.com/api/auth/handoffs/consume",
            HANDOFF_CONSUME_PATH
        )
        .is_some());
        for bad in [
            "https://evil.example/api/auth/handoffs/consume",
            "https://hatch.example.com/api/auth/handoffs/consume?next=/x",
            "https://hatch.example.com/api/auth/handoffs/consume#x",
            "https://u:p@hatch.example.com/api/auth/handoffs/consume",
            "https://hatch.example.com/app/x",
            "http://hatch.example.com/api/auth/handoffs/consume",
        ] {
            assert!(
                fixed_url(origin, bad, HANDOFF_CONSUME_PATH).is_none(),
                "{bad}"
            );
        }
    }

    #[test]
    fn only_the_grant_ends_a_browser_sign_in() {
        let poll = |status, body: &str| {
            classify_poll(status, &serde_json::from_str(body).unwrap_or(Value::Null))
        };
        assert_eq!(
            poll(400, r#"{"error":"authorization_pending"}"#).ok(),
            Some(DevicePoll::Pending)
        );
        assert_eq!(
            poll(400, r#"{"error":"slow_down"}"#).ok(),
            Some(DevicePoll::SlowDown)
        );
        assert_eq!(poll(429, "{}").ok(), Some(DevicePoll::SlowDown));
        assert_eq!(
            poll(400, r#"{"error":"access_denied"}"#).ok(),
            Some(DevicePoll::Denied)
        );
        assert_eq!(
            poll(400, r#"{"error":"expired_token"}"#).ok(),
            Some(DevicePoll::Expired)
        );
        assert_eq!(
            poll(200, r#"{"access_token":"abc.def"}"#).ok(),
            Some(DevicePoll::Approved("abc.def".into()))
        );
        // A restarting or overloaded server is not an answer.
        assert_eq!(
            poll(500, "Internal server error").ok(),
            Some(DevicePoll::Unavailable)
        );
        assert_eq!(poll(502, "{}").ok(), Some(DevicePoll::Unavailable));
        assert_eq!(poll(200, "<html>").ok(), Some(DevicePoll::Unavailable));
        assert!(poll(400, r#"{"error":"invalid_grant"}"#).is_err());
        assert!(poll(200, r#"{"access_token":"a b"}"#).is_err());
    }

    #[test]
    fn tokens_are_printable_ascii() {
        assert!(valid_token("abc.DEF_123"));
        assert!(!valid_token(""));
        assert!(!valid_token("a b"));
        assert!(!valid_token("a\nb"));
        assert!(!valid_token(&"a".repeat(8193)));
    }
}
