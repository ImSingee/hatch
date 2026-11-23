//! `hatch:` links, read with the grammar the platform and the phone app share
//! (`packages/hatch-platform-api/deep-link.ts`):
//! `hatch://<web path>[?instance=<origin>][#<fragment>]`. A link names a page
//! by its web path; it only ever navigates.

use crate::policy;

const MAX_LENGTH: usize = 4096;
const MAX_FRAGMENT: usize = 2048;
/// Sign-in, device login and API endpoints are never pages a link opens.
const RESERVED_ROOTS: &[&str] = &["api", "cli", "login"];

#[derive(Debug, PartialEq, Eq)]
pub struct HatchLink {
    /// Canonical origin the link names, or None for the instance in use.
    pub instance: Option<String>,
    /// The web path with its query and fragment, starting with `/`.
    pub path: String,
}

/// Controls, whitespace, DEL and backslashes are never part of a link.
fn forbidden(c: char) -> bool {
    c <= ' ' || c == '\u{7f}' || c == '\\'
}

/// Decodes ASCII percent-escapes, nested up to a few levels, so an encoded
/// separator or dot segment cannot hide. Excessive nesting is refused.
fn decode_ascii(value: &str) -> Option<String> {
    let mut text = value.to_owned();
    for _ in 0..4 {
        let decoded = decode_once(&text);
        if decoded == text {
            return Some(text);
        }
        text = decoded;
    }
    (decode_once(&text) == text).then_some(text)
}

fn decode_once(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('%') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let byte = tail
            .get(1..3)
            .filter(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            .filter(|byte| *byte < 0x80);
        match byte {
            Some(byte) => {
                out.push(byte as char);
                rest = &tail[3..];
            }
            None => {
                out.push('%');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn segment_ok(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 256
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-'))
}

/// A link's instance: an origin, or a bare host that means HTTPS.
fn link_instance(value: &str) -> Option<String> {
    policy::canonical_instance(value).ok()
}

/// Reads a `hatch:` link. Anything malformed or unsafe is None.
pub fn parse(value: &str) -> Option<HatchLink> {
    if value.len() > MAX_LENGTH || value.chars().any(forbidden) {
        return None;
    }
    let lower = value.get(..6)?.to_ascii_lowercase();
    if lower != "hatch:" {
        return None;
    }
    let rest = &value[6..];
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let (before_hash, fragment) = match rest.split_once('#') {
        Some((before, fragment)) => (before, Some(fragment)),
        None => (rest, None),
    };
    let (path, query) = match before_hash.split_once('?') {
        Some((path, query)) => (path, query),
        None => (before_hash, ""),
    };
    if path.starts_with("expo-development-client") {
        return None;
    }

    let mut instance = None;
    let mut search = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, raw) = pair.split_once('=').unwrap_or((pair, ""));
        if key != "instance" {
            search.push(pair);
            continue;
        }
        // A link naming two instances names neither.
        if instance.is_some() {
            return None;
        }
        let decoded = decode_ascii(raw)?;
        instance = Some(link_instance(&decoded)?);
    }

    let trimmed = path.trim_start_matches('/').trim_end_matches('/');
    let mut segments = Vec::new();
    if !trimmed.is_empty() {
        for raw in trimmed.split('/') {
            let segment = decode_ascii(raw)?;
            if !segment_ok(&segment) {
                return None;
            }
            segments.push(segment);
        }
    }
    if segments
        .first()
        .is_some_and(|first| RESERVED_ROOTS.contains(&first.as_str()))
    {
        return None;
    }
    let hash = fragment.unwrap_or("");
    if hash.len() > MAX_FRAGMENT {
        return None;
    }

    let mut web_path = format!("/{}", segments.join("/"));
    if !search.is_empty() {
        web_path.push('?');
        web_path.push_str(&search.join("&"));
    }
    if !hash.is_empty() {
        web_path.push('#');
        web_path.push_str(hash);
    }
    Some(HatchLink {
        instance,
        path: web_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> Option<String> {
        parse(value).map(|link| link.path)
    }

    #[test]
    fn links_name_web_paths() {
        assert_eq!(
            path("hatch://app/sales#/reports").as_deref(),
            Some("/app/sales#/reports")
        );
        assert_eq!(path("hatch:agent").as_deref(), Some("/agent"));
        assert_eq!(
            path("HATCH:///workflow/nightly/").as_deref(),
            Some("/workflow/nightly")
        );
        assert_eq!(path("hatch://").as_deref(), Some("/"));
        assert_eq!(
            path("hatch://apps?view=grid").as_deref(),
            Some("/apps?view=grid")
        );
    }

    #[test]
    fn links_may_name_their_instance() {
        let link = parse("hatch://agent?instance=hatch.example.com&x=1").unwrap();
        assert_eq!(link.instance.as_deref(), Some("https://hatch.example.com"));
        assert_eq!(link.path, "/agent?x=1");
        let encoded = parse("hatch://agent?instance=http%3A%2F%2Flocalhost%3A3791").unwrap();
        assert_eq!(encoded.instance.as_deref(), Some("http://localhost:3791"));
        assert_eq!(
            parse("hatch://agent?instance=a.example&instance=b.example"),
            None
        );
        assert_eq!(
            parse("hatch://agent?instance=http%3A%2F%2Fevil.example"),
            None
        );
    }

    #[test]
    fn unsafe_links_are_refused() {
        for bad in [
            "hatch://api/rpc",
            "hatch://login",
            "hatch://cli/authorize?user_code=X",
            "hatch://%61pi/x",
            "hatch://app/%2e%2e/api",
            "hatch://app/..",
            "hatch://app/a%2Fb",
            "hatch://app/a%252Fb",
            "hatch://app/x y",
            "hatch://app/x\\y",
            "hatch://expo-development-client/?url=x",
            "https://hatch.example.com/app",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        let long = format!("hatch://app/x#{}", "a".repeat(MAX_FRAGMENT + 1));
        assert_eq!(parse(&long), None);
    }
}
