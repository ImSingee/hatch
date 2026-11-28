//! The window's running native Apps: one NSH engine (`AppView`) per App,
//! each opened, placed, shown, hidden and stopped by the page's App surface
//! for it.
//!
//! The page's session store decides which Apps run, which one is in front,
//! which sits beside it, when a minimised App has waited too long, and when
//! a new deployment is available, as on the web Desk. This module keeps
//! what only the native side can: at most [`MAX_RUNNING`] engines, each
//! with a [`HEAP_BYTES`] JavaScript heap, running a package verified for
//! its App, with the bridge scoped to that App.

use nsh_engine::{HostCall, HostChannel, Limits};
use nsh_platform_macos::{AppOptions, AppView, Appearance, AssetBase};
use objc2::MainThreadMarker;
use objc2_app_kit::NSWindow;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::bridge::{self, AppScope, Endpoint, InstanceRequest, Planned, ShellRequest};
use super::view::{self, CssRect};
use super::{fetch, grant, package};

/// Running Apps per window, as the web Desk keeps (`WEB_RUNNING_APP_LIMIT`).
pub const MAX_RUNNING: usize = 12;
/// Each App's JavaScript heap.
pub const HEAP_BYTES: usize = 96 * 1024 * 1024;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

/// What the page asks for when an App surface starts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// The page's session key for the surface (one engine each).
    pub key: String,
    pub app_id: String,
    /// The route inside the App to start at ('' is its home).
    pub route: String,
    /// The page's platform shortcuts the App did not reserve, as physical
    /// chords (`meta+k`): pressed inside the App, they go to the page.
    #[serde(default)]
    pub shortcuts: Vec<String>,
}

/// What the page tells a running App.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SurfaceMessage {
    Navigate {
        route: String,
    },
    Theme,
    UpdateAvailable,
    /// The platform shortcuts the App no longer reserves changed (a new
    /// deployment's `keyboard.reserve`): the key monitor follows at once.
    Shortcuts {
        shortcuts: Vec<String>,
    },
}

/// A page's shortcut list, bounded as it came.
fn bounded_shortcuts(shortcuts: &[String]) -> Vec<String> {
    shortcuts
        .iter()
        .filter(|chord| chord.len() <= 32)
        .take(16)
        .cloned()
        .collect()
}

/// What the page hears about a surface (`hatch:native-app` events).
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum PageEvent {
    Ready {
        key: String,
        deployment_id: String,
        build: u32,
    },
    Failed {
        key: String,
        code: String,
        message: String,
    },
    Title {
        key: String,
        title: Option<String>,
    },
    Route {
        key: String,
        route: String,
    },
    Open {
        key: String,
        slug: String,
        route: String,
    },
    Shortcut {
        key: String,
        chord: String,
    },
}

/// Where the signed-in instance's native Apps keep their files, and what
/// they reach it with.
#[derive(Clone)]
pub struct Instance {
    pub origin: String,
    pub token: Arc<str>,
    pub http: reqwest::Client,
    /// `<app data>/native/<instance hash>/`: the trust store and the Apps'
    /// assets, which every account of the instance shares.
    pub dir: PathBuf,
    /// `<dir>/users/<user hash>/`: what the Apps keep for the signed-in
    /// account, never shown to another.
    pub account: PathBuf,
}

/// The first 8 bytes of SHA-256, in hex: a short, path-safe name.
fn short_hash(value: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(value.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `<base>/native/<instance hash>/`.
fn instance_dir(base: &std::path::Path, origin: &str) -> PathBuf {
    base.join("native").join(short_hash(origin))
}

/// `<instance dir>/users/<user hash>/`.
fn user_dir(base: &std::path::Path, origin: &str, user: &str) -> PathBuf {
    instance_dir(base, origin)
        .join("users")
        .join(short_hash(user))
}

/// Where native Apps keep `user`'s data on `origin`; sign-out removes it.
pub fn account_dir(app: &AppHandle, origin: &str, user: &str) -> Option<PathBuf> {
    Some(user_dir(&app.path().app_data_dir().ok()?, origin, user))
}

impl Instance {
    pub fn new(
        app: &AppHandle,
        origin: &str,
        token: &str,
        user: &str,
        user_agent: &str,
    ) -> Option<Self> {
        let base = app.path().app_data_dir().ok()?;
        Some(Self {
            origin: origin.to_owned(),
            token: token.into(),
            http: reqwest::Client::builder()
                .user_agent(user_agent)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()?,
            dir: instance_dir(&base, origin),
            account: user_dir(&base, origin, user),
        })
    }
}

/// Keys of the sessions opened or opening; checked before any work starts,
/// so the limit holds while packages download.
static OPEN: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Keys closed lately. The page's `open` and `close` of a surface may
/// arrive in either order (a surface mounted and unmounted at once), so a
/// key closed first must never open afterwards.
static CLOSED: Mutex<std::collections::VecDeque<String>> =
    Mutex::new(std::collections::VecDeque::new());
const CLOSED_REMEMBERED: usize = 256;

/// Trust stores write one file; loads take turns.
static TRUST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Reserves `key` unless it was closed. `reserve` and `forget` both hold
/// `CLOSED` while they look at or change `OPEN` (always in that order), so a
/// close that arrives while the open reserves either finds the reservation
/// or leaves the tombstone the reservation then sees.
fn reserve(key: &str) -> Result<(), &'static str> {
    let closed = CLOSED.lock().unwrap();
    if closed.iter().any(|closed| closed == key) {
        return Err("cancelled");
    }
    let mut open = OPEN.lock().unwrap();
    let open = open.get_or_insert_with(HashSet::new);
    if open.contains(key) {
        return Err("already_exists");
    }
    if open.len() >= MAX_RUNNING {
        return Err("resource_exhausted");
    }
    open.insert(key.to_owned());
    Ok(())
}

fn still_open(key: &str) -> bool {
    OPEN.lock()
        .unwrap()
        .as_ref()
        .is_some_and(|open| open.contains(key))
}

fn release(key: &str) {
    if let Some(open) = OPEN.lock().unwrap().as_mut() {
        open.remove(key);
    }
}

fn forget(key: &str) {
    let mut closed = CLOSED.lock().unwrap();
    release(key);
    if closed.len() >= CLOSED_REMEMBERED {
        closed.pop_front();
    }
    closed.push_back(key.to_owned());
}

/// Session keys come from the page: short and plain.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
}

struct Session {
    view: Rc<AppView>,
    channel: HostChannel,
    /// The page shows the surface.
    visible: bool,
    /// One of the page's overlays covers it: the page shows its picture.
    covered: bool,
    theme: Arc<Mutex<ThemeState>>,
    shortcuts: Vec<String>,
}

impl Session {
    fn update_hidden(&self) {
        self.view.view().setHidden(self.covered || !self.visible);
    }
}

#[derive(Default)]
struct ThemeState {
    key: Option<String>,
    theme: Value,
}

thread_local! {
    /// Sessions by key; AppKit views live on the main thread.
    static SESSIONS: RefCell<HashMap<String, Session>> = RefCell::new(HashMap::new());
}

/// Tells the page about a surface.
fn notify(app: &AppHandle, event: &PageEvent) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(detail) = serde_json::to_string(event) else {
        return;
    };
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('hatch:native-app', {{ detail: {detail} }}))"
    ));
}

fn ns_window(app: &AppHandle) -> Option<objc2::rc::Retained<NSWindow>> {
    let window = app.get_webview_window("main")?;
    let pointer = window.ns_window().ok()?;
    // SAFETY: Tauri's main window is an NSWindow; retained for the call.
    unsafe { objc2::rc::Retained::retain(pointer as *mut NSWindow) }
}

/// The viewing user's theme for NSH (`GET /api/theme/native`): its key and
/// `cssVars` theme, and whether its appearance is dark.
async fn fetch_theme(instance: &Instance) -> Option<(String, Value, bool)> {
    let response = instance
        .http
        .get(format!("{}/api/theme/native", instance.origin))
        .bearer_auth(&*instance.token)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    let key = body.get("key")?.as_str()?.to_owned();
    let theme = body.get("theme")?.clone();
    theme.get("cssVars")?.get("light")?.as_object()?;
    let dark = body.get("appearance").and_then(Value::as_str) == Some("dark");
    Some((key, theme, dark))
}

/// Opens the App surface `request.key`: downloads and verifies the App's
/// live package, then starts it in a view of its own, hidden until the
/// page places it. The page hears `ready` or `failed`.
pub async fn open(app: AppHandle, instance: Instance, request: OpenRequest) {
    let key = request.key.clone();
    if !valid_key(&key) {
        return;
    }
    if let Err(code) = reserve(&key) {
        if code == "cancelled" {
            return;
        }
        let message = if code == "resource_exhausted" {
            format!("At most {MAX_RUNNING} Apps run at once.")
        } else {
            "This App surface is already running.".to_owned()
        };
        notify(
            &app,
            &PageEvent::Failed {
                key,
                code: code.into(),
                message,
            },
        );
        return;
    }
    match prepare(&instance, &request).await {
        Ok(prepared) => {
            let for_main = app.clone();
            let _ = app.run_on_main_thread(move || start(&for_main, instance, request, prepared));
        }
        Err(error) => {
            release(&key);
            notify(
                &app,
                &PageEvent::Failed {
                    key,
                    code: error.code,
                    message: error.message,
                },
            );
        }
    }
}

struct Prepared {
    loaded: nsh_engine::LoadedPackage,
    info: fetch::PackageInfo,
    theme: Option<(String, Value, bool)>,
}

async fn prepare(
    instance: &Instance,
    request: &OpenRequest,
) -> Result<Prepared, fetch::FetchError> {
    let failure = |code: &str, message: String| fetch::FetchError {
        code: code.into(),
        message,
    };
    let trust = fetch::runtime_trust(&instance.http, &instance.origin, &instance.token).await?;
    let (info, bytes) = fetch::app_package(
        &instance.http,
        &instance.origin,
        &instance.token,
        &request.app_id,
    )
    .await?;
    let theme = fetch_theme(instance).await;
    let _turn = TRUST.lock().await;
    let dir = instance.dir.clone();
    let app_id = request.app_id.clone();
    let loaded = tauri::async_runtime::spawn_blocking(move || {
        let mut store = package::open_store(&dir.join("trust"), &trust)?;
        package::load(&mut store, &app_id, &bytes, &dir.join("assets"))
    })
    .await
    .map_err(|e| failure("internal", e.to_string()))?
    .map_err(|message| {
        failure(
            "permission_denied",
            format!("The App's package was refused: {message}"),
        )
    })?;
    Ok(Prepared {
        loaded,
        info,
        theme,
    })
}

fn start(app: &AppHandle, instance: Instance, request: OpenRequest, prepared: Prepared) {
    let key = request.key.clone();
    // Closed while it downloaded.
    if !still_open(&key) {
        return;
    }
    let (Some(mtm), Some(window)) = (MainThreadMarker::new(), ns_window(app)) else {
        release(&key);
        return;
    };
    let Some(scope) = AppScope::new(&request.app_id, &prepared.info.deployment_id) else {
        release(&key);
        notify(
            app,
            &PageEvent::Failed {
                key,
                code: "internal".into(),
                message: "The instance named an invalid App.".into(),
            },
        );
        return;
    };
    let channel = HostChannel::new();
    let theme = Arc::new(Mutex::new(ThemeState::default()));
    let mut dark = false;
    if let Some((theme_key, value, is_dark)) = prepared.theme {
        *theme.lock().unwrap() = ThemeState {
            key: Some(theme_key),
            theme: value,
        };
        dark = is_dark;
    }
    let mut params = serde_json::Map::new();
    params.insert("route".into(), Value::String(request.route.clone()));
    channel.set_params(params);
    bind_bridge(app, &instance, &key, scope, &channel, &theme);

    let nsh_id = prepared.loaded.app.id.clone();
    let view = AppView::new(
        mtm,
        AppOptions {
            asset_base: Some(AssetBase::Directory(prepared.loaded.assets.clone())),
            app_id: nsh_id.clone(),
            title: nsh_id.clone(),
            appearance: if dark {
                Appearance::Dark
            } else {
                Appearance::Light
            },
            limits: Limits {
                memory_bytes: HEAP_BYTES,
                ..Limits::default()
            },
            data_dir: Some(instance.account.join("data").join(&nsh_id)),
            host: channel.clone(),
            ..AppOptions::default()
        },
    );
    if !view::attach(&window, &view.view()) {
        release(&key);
        return;
    }
    let current = theme.lock().unwrap().theme.clone();
    if !current.is_null() {
        let _ = channel.send("hatch.theme", json!({ "theme": current }));
    }
    view.load(prepared.loaded.bundle.into());
    SESSIONS.with(|sessions| {
        sessions.borrow_mut().insert(
            key.clone(),
            Session {
                view,
                channel,
                visible: false,
                covered: false,
                theme,
                shortcuts: bounded_shortcuts(&request.shortcuts),
            },
        )
    });
    notify(
        app,
        &PageEvent::Ready {
            key,
            deployment_id: prepared.info.deployment_id,
            build: prepared.info.build,
        },
    );
}

/// Answers the App's host calls: each checked by [`AppScope::plan`] and
/// scoped to the App the session opened.
fn bind_bridge(
    app: &AppHandle,
    instance: &Instance,
    key: &str,
    scope: AppScope,
    channel: &HostChannel,
    theme: &Arc<Mutex<ThemeState>>,
) {
    for name in grant::HOST_CALLS {
        let app = app.clone();
        let instance = instance.clone();
        let key = key.to_owned();
        let scope = scope.clone();
        let theme = theme.clone();
        channel.handle(name, move |call: HostCall| {
            match scope.plan(call.name(), call.data()) {
                Err(refusal) => call.resolve(refusal.envelope()),
                Ok(Planned::Answer(answer)) => call.resolve(answer),
                Ok(Planned::Theme) => {
                    let theme = theme.lock().unwrap().theme.clone();
                    call.resolve(json!({ "ok": true, "theme": theme }));
                }
                Ok(Planned::Shell(request)) => {
                    let event = match request {
                        ShellRequest::SetTitle(title) => PageEvent::Title {
                            key: key.clone(),
                            title,
                        },
                        ShellRequest::SetRoute(route) => PageEvent::Route {
                            key: key.clone(),
                            route,
                        },
                        ShellRequest::Open { slug, route } => PageEvent::Open {
                            key: key.clone(),
                            slug,
                            route,
                        },
                    };
                    let for_main = app.clone();
                    let _ = app.run_on_main_thread(move || notify(&for_main, &event));
                    call.resolve(json!({ "ok": true }));
                }
                Ok(Planned::Instance(request)) => {
                    let instance = instance.clone();
                    tauri::async_runtime::spawn(async move {
                        call.resolve(send(&instance, request).await);
                    });
                }
            }
        });
    }
}

/// Sends a planned request with the app's session and reads its answer.
async fn send(instance: &Instance, request: InstanceRequest) -> Value {
    let url = format!("{}{}", instance.origin, request.path);
    let mut builder = match request.method {
        "GET" => instance.http.get(url),
        _ => instance.http.post(url),
    }
    .bearer_auth(&*instance.token);
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    if request.endpoint != Endpoint::DataEvents {
        builder = builder.timeout(RPC_TIMEOUT);
    }
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            return json!({ "ok": false, "code": "unavailable", "message": error.to_string() })
        }
    };
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
        .collect();
    if request.endpoint == Endpoint::DataEvents && (200..300).contains(&status) {
        return json!({ "ok": true, "events": read_events(response).await });
    }
    let text = response.text().await.unwrap_or_default();
    bridge::answer(request.endpoint, status, &headers, &text)
}

/// Reads a change stream until its first events, or "none" after the wait.
async fn read_events(mut response: reqwest::Response) -> Vec<Value> {
    let mut text = String::new();
    let wait = tokio::time::timeout(bridge::DATA_EVENTS_WAIT, async {
        while let Ok(Some(chunk)) = response.chunk().await {
            text.push_str(&String::from_utf8_lossy(&chunk));
            // Only whole blocks count.
            if let Some(end) = text.rfind("\n\n") {
                let events = bridge::parse_events(&text[..end + 2]);
                if !events.is_empty() {
                    return events;
                }
            }
        }
        Vec::new()
    });
    wait.await.unwrap_or_default()
}

/// Places surface `key` and shows or hides it; a change of visibility is
/// the App's `hatch.visibility`. A hidden App keeps its size.
pub fn place(app: &AppHandle, key: &str, rect: CssRect, viewport_width: f64, visible: bool) {
    let Some(window) = ns_window(app) else {
        return;
    };
    SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        let Some(session) = sessions.get_mut(key) else {
            return;
        };
        view::place(&window, &session.view.view(), rect, viewport_width);
        if session.visible != visible {
            session.visible = visible;
            session.update_hidden();
            let _ = session
                .channel
                .send("hatch.visibility", json!({ "visible": visible }));
        }
    });
}

/// Hides surface `key` behind a picture of it, or shows it again: the page
/// draws the picture while one of its overlays covers the App. The App is
/// not told: it is still on screen.
pub fn cover(key: &str, covered: bool) {
    SESSIONS.with(|sessions| {
        if let Some(session) = sessions.borrow_mut().get_mut(key) {
            session.covered = covered;
            session.update_hidden();
        }
    });
}

/// A PNG of surface `key` as it shows now.
pub fn snapshot(key: &str) -> Option<Vec<u8>> {
    SESSIONS.with(|sessions| {
        let sessions = sessions.borrow();
        view::snapshot_png(&sessions.get(key)?.view.view())
    })
}

/// Gives surface `key` the keyboard.
pub fn focus(app: &AppHandle, key: &str) {
    let Some(window) = ns_window(app) else {
        return;
    };
    SESSIONS.with(|sessions| {
        if let Some(session) = sessions.borrow().get(key) {
            let container = session.view.view();
            if let Some(root) = container.subviews().iter().next() {
                window.makeFirstResponder(Some(&root));
            }
        }
    });
}

/// Delivers a page message to surface `key`.
pub async fn message(
    app: AppHandle,
    instance: Option<Instance>,
    key: String,
    message: SurfaceMessage,
) {
    if let SurfaceMessage::Shortcuts { shortcuts } = message {
        let shortcuts = bounded_shortcuts(&shortcuts);
        let _ = app.run_on_main_thread(move || {
            SESSIONS.with(|sessions| {
                if let Some(session) = sessions.borrow_mut().get_mut(&key) {
                    session.shortcuts = shortcuts;
                }
            });
        });
        return;
    }
    let channel_and_theme = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let key = key.clone();
        let _ = app.run_on_main_thread(move || {
            let found = SESSIONS.with(|sessions| {
                sessions
                    .borrow()
                    .get(&key)
                    .map(|s| (s.channel.clone(), s.theme.clone()))
            });
            let _ = tx.send(found);
        });
        rx.await.ok().flatten()
    };
    let Some((channel, theme)) = channel_and_theme else {
        return;
    };
    match message {
        SurfaceMessage::Navigate { route } if route.len() <= 4096 => {
            let _ = channel.send("hatch.nav", json!({ "route": route }));
        }
        SurfaceMessage::Navigate { .. } => {}
        SurfaceMessage::UpdateAvailable => {
            let _ = channel.send("hatch.update", json!({}));
        }
        SurfaceMessage::Shortcuts { .. } => {}
        SurfaceMessage::Theme => {
            let Some(instance) = instance else { return };
            if let Some((theme_key, value, _)) = fetch_theme(&instance).await {
                let changed = {
                    let mut state = theme.lock().unwrap();
                    let changed = state.key.as_deref() != Some(&theme_key);
                    *state = ThemeState {
                        key: Some(theme_key),
                        theme: value.clone(),
                    };
                    changed
                };
                if changed {
                    let _ = channel.send("hatch.theme", json!({ "theme": value }));
                }
            }
        }
    }
}

/// Stops surface `key`'s App and removes its view; it never opens again.
pub fn close(key: &str) {
    forget(key);
    if let Some(session) = SESSIONS.with(|sessions| sessions.borrow_mut().remove(key)) {
        session.view.stop();
        session.view.view().removeFromSuperview();
    }
}

/// Stops every App: the session ended or the window left the instance.
pub fn close_all() {
    let keys: Vec<String> = SESSIONS.with(|sessions| sessions.borrow().keys().cloned().collect());
    for key in keys {
        close(&key);
    }
    *OPEN.lock().unwrap() = None;
}

/// The chord of a key press as the page names it (`keyboardEventChord`
/// in `@hatch/manifest`): modifiers in the order ctrl, meta, alt, shift,
/// then the key.
pub fn chord(control: bool, command: bool, option: bool, shift: bool, key: &str) -> Option<String> {
    let key = key.to_ascii_lowercase();
    let named = key.len() == 1 && key.bytes().all(|b| b.is_ascii_alphanumeric());
    if !named {
        return None;
    }
    let mut parts = Vec::new();
    for (on, name) in [
        (control, "ctrl"),
        (command, "meta"),
        (option, "alt"),
        (shift, "shift"),
    ] {
        if on {
            parts.push(name);
        }
    }
    parts.push(&key);
    Some(parts.join("+"))
}

/// The surface whose view holds `responder`, and whether `chord` is one of
/// its page shortcuts.
fn shortcut_owner(responder: &objc2_app_kit::NSView, chord: &str) -> Option<String> {
    SESSIONS.with(|sessions| {
        sessions.borrow().iter().find_map(|(key, session)| {
            (responder.isDescendantOf(&session.view.view())
                && session.shortcuts.iter().any(|c| c == chord))
            .then(|| key.clone())
        })
    })
}

/// Hands the page's platform shortcuts back to it while the keyboard is in
/// a native App (key presses there never reach the page). Installed once.
pub fn install_shortcut_monitor(app: &AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    let app = app.clone();
    let handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event.
        let event_ref = unsafe { event.as_ref() };
        let pass = event.as_ptr();
        // Local monitors run on the main thread.
        let Some(mtm) = MainThreadMarker::new() else {
            return pass;
        };
        let Some(window) = event_ref.window(mtm) else {
            return pass;
        };
        let Some(responder) = window.firstResponder() else {
            return pass;
        };
        let Ok(view) = responder.downcast::<objc2_app_kit::NSView>() else {
            return pass;
        };
        let flags = event_ref.modifierFlags();
        let Some(key) = event_ref.charactersIgnoringModifiers() else {
            return pass;
        };
        let Some(chord) = chord(
            flags.contains(NSEventModifierFlags::Control),
            flags.contains(NSEventModifierFlags::Command),
            flags.contains(NSEventModifierFlags::Option),
            flags.contains(NSEventModifierFlags::Shift),
            &key.to_string(),
        ) else {
            return pass;
        };
        match shortcut_owner(&view, &chord) {
            Some(key) => {
                notify(&app, &PageEvent::Shortcut { key, chord });
                std::ptr::null_mut()
            }
            None => pass,
        }
    });
    // SAFETY: the monitor lives as long as the app.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
    };
    std::mem::forget(monitor);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that reserve keys share `OPEN` and `CLOSED`: one at a time.
    static KEYS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn chords_match_the_page() {
        assert_eq!(
            chord(false, true, false, false, "K").as_deref(),
            Some("meta+k")
        );
        assert_eq!(
            chord(true, true, true, true, "1").as_deref(),
            Some("ctrl+meta+alt+shift+1")
        );
        assert_eq!(chord(false, true, false, false, "\u{1b}"), None);
        assert_eq!(chord(false, true, false, false, "ab"), None);
    }

    #[test]
    fn keys_are_plain() {
        assert!(valid_key("field-notes:1"));
        assert!(!valid_key(""));
        assert!(!valid_key("a b"));
        assert!(!valid_key("x');alert(1);//"));
        assert!(!valid_key(&"k".repeat(129)));
    }

    #[test]
    fn a_surface_closed_before_it_opened_never_opens() {
        let _keys = KEYS.lock().unwrap_or_else(|e| e.into_inner());
        close("closed-first");
        assert_eq!(reserve("closed-first"), Err("cancelled"));
    }

    #[test]
    fn a_close_racing_the_open_never_leaves_the_key_open() {
        let _keys = KEYS.lock().unwrap_or_else(|e| e.into_inner());
        // Whichever of the two runs first, once both have run the key is not
        // open: no engine starts for a surface that is gone.
        for n in 0..2000 {
            let key = format!("race-{n}");
            let opening = {
                let key = key.clone();
                std::thread::spawn(move || {
                    let _ = reserve(&key);
                })
            };
            let closing = {
                let key = key.clone();
                std::thread::spawn(move || forget(&key))
            };
            opening.join().unwrap();
            closing.join().unwrap();
            assert!(!still_open(&key), "{key} stayed open after its close");
        }
    }

    #[test]
    fn each_account_keeps_its_own_app_data() {
        let base = std::path::Path::new("/data");
        let origin = "https://hatch.example.com";
        let avery = user_dir(base, origin, "user-avery");
        let blake = user_dir(base, origin, "user-blake");
        // Two accounts of one instance never share App data, and one
        // account's directory stays the same from one sign-in to the next.
        assert_ne!(avery, blake);
        assert_eq!(avery, user_dir(base, origin, "user-avery"));
        // Under the instance, beside its shared trust store and assets.
        assert!(avery.starts_with(instance_dir(base, origin)));
        assert_ne!(avery, instance_dir(base, origin));
        // Another instance's account of the same id is another directory.
        assert_ne!(
            avery,
            user_dir(base, "https://other.example.com", "user-avery")
        );
    }

    #[test]
    fn at_most_twelve_run() {
        let _keys = KEYS.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<String> = (0..MAX_RUNNING)
            .map(|n| format!("limit-test-{n}"))
            .collect();
        for key in &keys {
            assert_eq!(reserve(key), Ok(()));
        }
        assert_eq!(reserve("limit-test-one-more"), Err("resource_exhausted"));
        assert_eq!(reserve(&keys[0]), Err("already_exists"));
        release(&keys[0]);
        assert_eq!(reserve("limit-test-one-more"), Ok(()));
        for key in keys.iter().skip(1) {
            release(key);
        }
        release("limit-test-one-more");
    }
}
