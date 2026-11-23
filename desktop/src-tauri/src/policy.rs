//! What the window may load. Pure functions so the rules are tested apart
//! from WebKit; `webkit.rs` and `lib.rs` apply them.
//!
//! - The top-level page shows the configured instance, or the bundled
//!   first-run page. Anything else the person clicks opens in the default
//!   browser (http, https, mailto, tel and other app schemes) or, for
//!   `hatch:` links, as a page of this instance.
//! - Frames inside a page may load the web as browsers allow: Apps embed
//!   maps, videos and other sites. They may never reach the bundled pages
//!   or local files.
//! - New windows (`target=_blank`, `window.open`) never open in the app.

use url::Url;

/// Schemes that resolve inside a document, or reach the app's own pages and
/// files. A link never opens one in another app.
const DOCUMENT_SCHEMES: &[&str] = &["about", "blob", "data", "file", "javascript"];
/// The bundled first-run page and Tauri's internal schemes.
const APP_SCHEMES: &[&str] = &["tauri", "ipc", "asset", "http-ipc"];

/// Hosts that may serve an instance over plain HTTP: this Mac only.
const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

/// An instance address must be an origin and nothing more.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidInstance;

/// Canonical origin of the instance address a person typed. A bare host means
/// HTTPS; plain HTTP is accepted only for this Mac. No credentials, path,
/// query or fragment.
pub fn canonical_instance(input: &str) -> Result<String, InvalidInstance> {
    let text = input.trim();
    if text.is_empty()
        || text.len() > 2048
        || text
            .chars()
            .any(|c| c.is_control() || c == ' ' || c == '\\')
        || text.contains(['?', '#', '@'])
    {
        return Err(InvalidInstance);
    }
    let with_scheme = if text.contains("://") {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    // Check the raw authority before the parser normalises dot segments.
    let after_scheme = with_scheme
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or(InvalidInstance)?;
    let path = after_scheme
        .split_once('/')
        .map(|(_, path)| path)
        .unwrap_or("");
    if !path.is_empty() {
        return Err(InvalidInstance);
    }
    let url = Url::parse(&with_scheme).map_err(|_| InvalidInstance)?;
    let host = url.host_str().ok_or(InvalidInstance)?;
    let secure = url.scheme() == "https";
    let loopback = url.scheme() == "http" && LOOPBACK_HOSTS.contains(&host);
    if !(secure || loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
    {
        return Err(InvalidInstance);
    }
    Ok(url.origin().ascii_serialization())
}

/// Whether `url` is a page of `instance` (an origin from `canonical_instance`).
pub fn on_instance(instance: &str, url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.origin().ascii_serialization() == instance
        && url.username().is_empty()
        && url.password().is_none()
}

#[derive(Debug, PartialEq, Eq)]
pub enum TopLevel {
    /// Load it in the window.
    Allow,
    /// Leave it to the app that owns its scheme.
    OpenExternally(Url),
    /// A `hatch:` link: open the page it names.
    DeepLink(String),
    Deny,
}

/// Decides a navigation of the window's top-level page.
///
/// `showing_bundled` says whether the window currently shows the bundled
/// first-run page; `bundled_requested` whether the app itself just asked for
/// it. A page of the instance can therefore never navigate to the bundled
/// page, where the sign-in commands are reachable.
pub fn decide_top_level(
    instance: Option<&str>,
    raw: &str,
    showing_bundled: bool,
    bundled_requested: bool,
) -> TopLevel {
    let Ok(url) = Url::parse(raw) else {
        return TopLevel::Deny;
    };
    let scheme = url.scheme();
    if scheme == "hatch" {
        return TopLevel::DeepLink(raw.to_owned());
    }
    if scheme == "tauri" {
        let local = url.host_str() == Some("localhost");
        return if local && (showing_bundled || bundled_requested) {
            TopLevel::Allow
        } else {
            TopLevel::Deny
        };
    }
    if scheme == "about" && url.path() == "blank" {
        return TopLevel::Allow;
    }
    if DOCUMENT_SCHEMES.contains(&scheme) || APP_SCHEMES.contains(&scheme) {
        return TopLevel::Deny;
    }
    if let Some(instance) = instance {
        if on_instance(instance, &url) {
            return TopLevel::Allow;
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return TopLevel::Deny;
    }
    TopLevel::OpenExternally(url)
}

/// Decides a navigation inside a frame of the page.
pub fn allow_subframe(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    match url.scheme() {
        "http" | "https" => url.username().is_empty() && url.password().is_none(),
        // Frames start as about:blank or about:srcdoc; Apps build frames
        // from data and blob URLs.
        "about" | "data" | "blob" => true,
        _ => false,
    }
}

/// A page asked for a new window. The app has one window, so the address
/// goes to the default browser (or, for `hatch:` links, opens here).
pub fn decide_new_window(raw: &str) -> TopLevel {
    let Ok(url) = Url::parse(raw) else {
        return TopLevel::Deny;
    };
    let scheme = url.scheme();
    if scheme == "hatch" {
        return TopLevel::DeepLink(raw.to_owned());
    }
    if DOCUMENT_SCHEMES.contains(&scheme)
        || APP_SCHEMES.contains(&scheme)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return TopLevel::Deny;
    }
    TopLevel::OpenExternally(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTANCE: &str = "https://hatch.example.com";

    #[test]
    fn instance_addresses_are_bare_origins() {
        assert_eq!(
            canonical_instance("hatch.example.com").as_deref(),
            Ok(INSTANCE)
        );
        assert_eq!(
            canonical_instance(" https://Hatch.Example.com/ ").as_deref(),
            Ok(INSTANCE)
        );
        assert_eq!(
            canonical_instance("http://localhost:3791").as_deref(),
            Ok("http://localhost:3791")
        );
        for bad in [
            "",
            "http://hatch.example.com",
            "http://192.168.1.4:3000",
            "ftp://hatch.example.com",
            "https://user:pw@hatch.example.com",
            "https://hatch.example.com/app",
            "https://hatch.example.com/..",
            "https://hatch.example.com?x=1",
            "https://hatch.example.com#x",
            "https://hatch example.com",
            "https://hatch.example.com\\evil",
        ] {
            assert_eq!(canonical_instance(bad), Err(InvalidInstance), "{bad}");
        }
    }

    #[test]
    fn the_window_shows_only_the_instance() {
        let top = |raw| decide_top_level(Some(INSTANCE), raw, false, false);
        assert_eq!(top("https://hatch.example.com/agent"), TopLevel::Allow);
        assert_eq!(top("about:blank"), TopLevel::Allow);
        assert!(matches!(
            top("https://elsewhere.example/"),
            TopLevel::OpenExternally(_)
        ));
        // Same host, other scheme or port, is another origin.
        assert!(matches!(
            top("http://hatch.example.com/"),
            TopLevel::OpenExternally(_)
        ));
        assert!(matches!(
            top("https://hatch.example.com:8443/"),
            TopLevel::OpenExternally(_)
        ));
        assert!(matches!(
            top("mailto:a@example.com"),
            TopLevel::OpenExternally(_)
        ));
        assert_eq!(
            top("hatch://app/notes"),
            TopLevel::DeepLink("hatch://app/notes".into())
        );
        for denied in [
            "javascript:alert(1)",
            "data:text/html,hi",
            "file:///etc/passwd",
            "blob:https://hatch.example.com/x",
            "https://user:pw@elsewhere.example/",
            "not a url",
        ] {
            assert_eq!(top(denied), TopLevel::Deny, "{denied}");
        }
    }

    #[test]
    fn instance_pages_cannot_reach_the_bundled_page() {
        let bundled = "tauri://localhost/index.html";
        assert_eq!(
            decide_top_level(Some(INSTANCE), bundled, false, false),
            TopLevel::Deny
        );
        assert_eq!(
            decide_top_level(Some(INSTANCE), bundled, false, true),
            TopLevel::Allow
        );
        assert_eq!(
            decide_top_level(None, bundled, true, false),
            TopLevel::Allow
        );
        assert_eq!(
            decide_top_level(None, "tauri://elsewhere/", true, true),
            TopLevel::Deny
        );
        // Before an instance is chosen nothing remote loads in the window.
        assert!(matches!(
            decide_top_level(None, "https://hatch.example.com/", true, false),
            TopLevel::OpenExternally(_)
        ));
    }

    #[test]
    fn frames_load_the_web_but_not_the_app() {
        for allowed in [
            "https://maps.example/embed",
            "http://video.example/",
            "about:srcdoc",
            "data:text/html,x",
            "blob:https://hatch.example.com/1",
        ] {
            assert!(allow_subframe(allowed), "{allowed}");
        }
        for denied in [
            "tauri://localhost/index.html",
            "ipc://localhost/x",
            "file:///Users",
            "hatch://app/x",
            "zoommtg://join",
            "https://u:p@example.com/",
        ] {
            assert!(!allow_subframe(denied), "{denied}");
        }
    }

    #[test]
    fn new_windows_leave_the_app() {
        assert!(matches!(
            decide_new_window("https://hatch.example.com/app/x"),
            TopLevel::OpenExternally(_)
        ));
        assert!(matches!(
            decide_new_window("hatch://agent"),
            TopLevel::DeepLink(_)
        ));
        assert_eq!(decide_new_window("javascript:1"), TopLevel::Deny);
        assert_eq!(decide_new_window("tauri://localhost/"), TopLevel::Deny);
    }
}
