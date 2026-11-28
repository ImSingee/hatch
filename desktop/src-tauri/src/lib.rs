//! Hatch for macOS: one window that shows a Hatch instance's own web UI.
//!
//! Native: the window and its traffic lights, the menu and shortcuts, the
//! first-run page (instance address and sign-in), the session in the
//! Keychain, deep links, and the rule that the window shows only the
//! instance. Web: every Hatch page, in its desktop layout (the page sees
//! `HatchDesktop/<version>` in the user agent and draws the sidebar).
//!
//! The window's browser storage is not persistent. Its session comes from the
//! Keychain at launch through the platform's browser handoff
//! (`AuthService.CreateHandoff`), so no credential is written to disk outside
//! the Keychain.

mod api;
mod appearance;
mod deep_link;
mod menu;
mod native;
mod policy;
#[cfg(any(debug_assertions, feature = "probes"))]
mod probes;
mod store;
mod webkit;

use api::{ApiError, DevicePoll, Instance};
use serde::Serialize;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use store::{keychain, Settings, SettingsFile};
use tauri::{
    ipc::CapabilityBuilder,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    window::Color,
    AppHandle, Emitter, LogicalPosition, Manager, RunEvent, TitleBarStyle, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";
const START_PATH: &str = "/dashboard";
const BUNDLED_PAGE: &str = "tauri://localhost/index.html";
/// The desk's ground colour (`tokens.json` → `light.background`), shown
/// before a page paints.
const GROUND: Color = Color(0xED, 0xEB, 0xE6, 0xFF);

/// What the window shows. Every step but `Instance` is the bundled page,
/// which renders whatever this says.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "step",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Screen {
    Connect {
        instance: Option<String>,
        error: Option<String>,
    },
    SignIn {
        instance: String,
        error: Option<String>,
    },
    Working {
        instance: Option<String>,
        message: String,
    },
    BrowserSignIn {
        instance: String,
        user_code: String,
        verification_url: String,
    },
    /// The instance could not be reached with a saved session.
    Offline { instance: String, error: String },
    /// The instance's own pages.
    Instance,
}

struct Shared {
    settings_file: SettingsFile,
    settings: Mutex<Settings>,
    screen: Mutex<Screen>,
    http: reqwest::Client,
    /// A deep link that arrived before the window was signed in.
    pending_path: Mutex<Option<String>>,
    /// After a handoff: its completion page, and where to go once it loads.
    completion: Mutex<Option<(Url, Url)>>,
    /// The app itself asked for the bundled page (see `policy`).
    bundled_requested: AtomicBool,
    /// The current session flow (see `Flow`).
    flow: AtomicU64,
    /// The page's zoom factor (View → Zoom In / Out).
    zoom: Mutex<f64>,
    /// The session the window was signed in with (instance origin, token,
    /// user id), for native Apps: read once from the Keychain, not on every
    /// App.
    session: Mutex<Option<(String, String, String)>>,
}

/// One session action: launch or retry, connect, browser sign-in, cancel,
/// switch instance, sign out, or a session found ended. Starting one
/// abandons any other still awaiting the instance, so a late answer can
/// never undo what the person did since (show an old instance, or sign back
/// in after Sign Out).
#[derive(Clone, Copy)]
struct Flow(u64);

impl Flow {
    fn begin(app: &AppHandle) -> Self {
        Self(shared(app).flow.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn current(self, app: &AppHandle) -> bool {
        shared(app).flow.load(Ordering::SeqCst) == self.0
    }
}

fn shared(app: &AppHandle) -> tauri::State<'_, Shared> {
    app.state::<Shared>()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn instance_origin(app: &AppHandle) -> Option<String> {
    shared(app).settings.lock().unwrap().instance.clone()
}

fn user_agent(app: &AppHandle) -> String {
    format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) HatchDesktop/{}",
        app.package_info().version
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenPayload {
    screen: Screen,
    accent: Option<String>,
}

fn payload(app: &AppHandle) -> ScreenPayload {
    let shared = shared(app);
    let screen = shared.screen.lock().unwrap().clone();
    let accent = shared.settings.lock().unwrap().accent.clone();
    ScreenPayload { screen, accent }
}

/// Shows `screen`. Anything but `Instance` brings back the bundled page.
fn set_screen(app: &AppHandle, screen: Screen) {
    let bundled = !matches!(screen, Screen::Instance);
    if bundled {
        *shared(app).session.lock().unwrap() = None;
        let _ = app.run_on_main_thread(native::session::close_all);
    }
    *shared(app).screen.lock().unwrap() = screen;
    if bundled {
        if let Some(window) = main_window(app) {
            let showing = window.url().is_ok_and(|url| url.scheme() == "tauri");
            if !showing {
                shared(app).bundled_requested.store(true, Ordering::SeqCst);
                let _ = window.navigate(Url::parse(BUNDLED_PAGE).unwrap());
            }
        }
    }
    let _ = app.emit_to(MAIN, "screen", payload(app));
}

fn save_settings(app: &AppHandle, update: impl FnOnce(&mut Settings)) {
    let shared = shared(app);
    let mut settings = shared.settings.lock().unwrap();
    update(&mut settings);
    if let Err(error) = shared.settings_file.save(&settings) {
        eprintln!("hatch: could not save settings: {error}");
    }
}

/// Lets the instance's pages move the window from their drag regions. That
/// is the only thing a remote page may ask of the app.
fn allow_instance_drag(app: &AppHandle, origin: &str) {
    let id = format!(
        "instance-{}",
        origin
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() {
                b as char
            } else {
                '-'
            })
            .collect::<String>()
    );
    let capability = CapabilityBuilder::new(id)
        .remote(format!("{origin}/*"))
        .window(MAIN)
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize")
        .permission("allow-native-app-open")
        .permission("allow-native-app-place")
        .permission("allow-native-app-cover")
        .permission("allow-native-app-snapshot")
        .permission("allow-native-app-focus")
        .permission("allow-native-app-message")
        .permission("allow-native-app-close");
    if let Err(error) = app.add_capability(capability) {
        eprintln!("hatch: drag regions unavailable: {error}");
    }
}

// ---------------------------------------------------------------------------
// Session

/// Launch, or retry: show the saved instance with its saved session.
async fn start(app: AppHandle) {
    let flow = Flow::begin(&app);
    let Some(origin) = instance_origin(&app) else {
        set_screen(
            &app,
            Screen::Connect {
                instance: None,
                error: None,
            },
        );
        return;
    };
    allow_instance_drag(&app, &origin);
    match keychain::get(&origin) {
        Ok(Some(token)) => restore(app, origin, token, flow).await,
        Ok(None) => set_screen(
            &app,
            Screen::SignIn {
                instance: origin,
                error: None,
            },
        ),
        Err(error) => set_screen(
            &app,
            Screen::SignIn {
                instance: origin,
                error: Some(error),
            },
        ),
    }
}

/// Signs the window in with a saved session and opens the start page (or a
/// pending deep link).
async fn restore(app: AppHandle, origin: String, token: String, flow: Flow) {
    set_screen(
        &app,
        Screen::Working {
            instance: Some(origin.clone()),
            message: "Signing in…".into(),
        },
    );
    let http = shared(&app).http.clone();
    let instance = Instance {
        http: &http,
        origin: &origin,
    };
    let result = async {
        let signed_in = instance.status(&token).await?;
        Ok::<_, ApiError>((signed_in, instance.handoff(&token).await?))
    }
    .await;
    if !flow.current(&app) {
        return;
    }
    match result {
        Ok((signed_in, handoff)) => {
            *shared(&app).session.lock().unwrap() =
                Some((origin.clone(), token.clone(), signed_in.user_id));
            tauri::async_runtime::spawn(refresh_accent(app.clone(), origin.clone(), token));
            let path = shared(&app)
                .pending_path
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| START_PATH.to_owned());
            let Ok(destination) = Url::parse(&origin).and_then(|base| base.join(&path)) else {
                return;
            };
            *shared(&app).completion.lock().unwrap() =
                Some((handoff.completion_url.clone(), destination));
            *shared(&app).screen.lock().unwrap() = Screen::Instance;
            let _ = app.emit_to(MAIN, "screen", payload(&app));
            if let Some(window) = main_window(&app) {
                let body = format!("ticket={}", handoff.ticket);
                let url = handoff.url.to_string();
                let _ = window.with_webview(move |webview| unsafe {
                    webkit::load_form_post(webview.inner(), &url, &body, &origin);
                });
            }
        }
        Err(ApiError::Unauthorized) => {
            let _ = keychain::remove(&origin);
            set_screen(
                &app,
                Screen::SignIn {
                    instance: origin,
                    error: None,
                },
            );
        }
        Err(error) => set_screen(
            &app,
            Screen::Offline {
                instance: origin,
                error: error.message(),
            },
        ),
    }
}

async fn refresh_accent(app: AppHandle, origin: String, token: String) {
    let http = shared(&app).http.clone();
    if let Ok(Some(accent)) = (Instance {
        http: &http,
        origin: &origin,
    })
    .accent(&token)
    .await
    {
        save_settings(&app, |settings| settings.accent = Some(accent));
        let _ = app.emit_to(MAIN, "screen", payload(&app));
    }
}

/// The window reached the instance's own sign-in page: the web session
/// ended (signed out in the page, or expired). Signing in happens in the
/// browser, so the app shows its own sign-in screen instead, after checking
/// whether the saved session still works.
async fn session_ended(app: AppHandle, origin: String) {
    if !matches!(*shared(&app).screen.lock().unwrap(), Screen::Instance) {
        return;
    }
    let flow = Flow::begin(&app);
    let saved = keychain::get(&origin).ok().flatten();
    if let Some(token) = saved {
        let http = shared(&app).http.clone();
        let status = (Instance {
            http: &http,
            origin: &origin,
        })
        .status(&token)
        .await;
        if !flow.current(&app) {
            return;
        }
        match status {
            // The window lost its cookie but the session lives: sign the
            // window in again.
            Ok(_) => return restore(app, origin, token, flow).await,
            Err(ApiError::Unauthorized) => {
                let _ = keychain::remove(&origin);
            }
            Err(error) => {
                set_screen(
                    &app,
                    Screen::Offline {
                        instance: origin,
                        error: error.message(),
                    },
                );
                return;
            }
        }
    }
    set_screen(
        &app,
        Screen::SignIn {
            instance: origin,
            error: None,
        },
    );
}

fn on_page_load(window: &WebviewWindow, url: &Url) {
    let app = window.app_handle().clone();
    let Some(origin) = instance_origin(&app) else {
        return;
    };
    if !policy::on_instance(&origin, url) {
        return;
    }
    let completion = shared(&app).completion.lock().unwrap().clone();
    if let Some((completion_url, destination)) = completion {
        if url.path() == completion_url.path() {
            *shared(&app).completion.lock().unwrap() = None;
            // Replace, so the sign-in pages never enter the page's history.
            let _ = window.eval(format!("location.replace({})", json!(destination.as_str())));
        }
    }
}

/// The page's address changed (a load or a history push). Sign-out and an
/// expired session both end on `/login`, often through the router alone.
fn on_url_change(app: &AppHandle, raw: &str) {
    let Some(origin) = instance_origin(app) else {
        return;
    };
    let Ok(url) = Url::parse(raw) else { return };
    if !policy::on_instance(&origin, &url) || url.path().starts_with("/api/") {
        return;
    }
    let path = url.path();
    if path == "/login" || path.starts_with("/login/") || path.starts_with("/cli/") {
        tauri::async_runtime::spawn(session_ended(app.clone(), origin));
    }
}

/// Signs out: everything local happens at once, before any await, so a
/// session action the person takes while the instance answers is never
/// undone (its cookies cleared, its new token removed). Ending the session
/// on the instance follows in the background.
async fn sign_out(app: AppHandle) {
    // Also abandons a browser sign-in still waiting for approval, which would
    // otherwise sign the app back in.
    Flow::begin(&app);
    let Some(origin) = instance_origin(&app) else {
        return;
    };
    let token = keychain::get(&origin).ok().flatten();
    let _ = keychain::remove(&origin);
    if let Some(window) = main_window(&app) {
        let _ = window.clear_all_browsing_data();
    }
    // Native Apps keep this account's data apart, like the window's browsing
    // data: it goes too, after `set_screen` below stops the engines (both
    // run on the main thread, in order).
    let account = shared(&app)
        .session
        .lock()
        .unwrap()
        .clone()
        .filter(|(signed_in, _, _)| *signed_in == origin)
        .and_then(|(_, _, user)| native::session::account_dir(&app, &origin, &user));
    set_screen(
        &app,
        Screen::SignIn {
            instance: origin.clone(),
            error: None,
        },
    );
    if let Some(dir) = account {
        let _ = app.run_on_main_thread(move || {
            let _ = std::fs::remove_dir_all(dir);
        });
    }
    if let Some(token) = token {
        let http = shared(&app).http.clone();
        if let Err(error) = (Instance {
            http: &http,
            origin: &origin,
        })
        .sign_out(&token)
        .await
        {
            eprintln!("hatch: {}", error.message());
        }
    }
}

// ---------------------------------------------------------------------------
// Commands from the bundled page

#[tauri::command]
fn get_screen(app: AppHandle) -> ScreenPayload {
    payload(&app)
}

#[tauri::command]
async fn connect(app: AppHandle, address: String) -> Result<(), String> {
    let origin = policy::canonical_instance(&address).map_err(|_| {
        "Enter the instance's address, like hatch.example.com. Plain http:// works only for this Mac (localhost).".to_owned()
    })?;
    let flow = Flow::begin(&app);
    set_screen(
        &app,
        Screen::Working {
            instance: Some(origin.clone()),
            message: format!("Connecting to {origin}…"),
        },
    );
    let http = shared(&app).http.clone();
    let probed = (Instance {
        http: &http,
        origin: &origin,
    })
    .probe()
    .await;
    if !flow.current(&app) {
        return Ok(());
    }
    if let Err(error) = probed {
        set_screen(
            &app,
            Screen::Connect {
                instance: Some(origin),
                error: Some(error.message()),
            },
        );
        return Ok(());
    }
    let changed = instance_origin(&app).as_deref() != Some(&origin);
    save_settings(&app, |settings| {
        if changed {
            settings.accent = None;
        }
        settings.instance = Some(origin.clone());
    });
    start(app).await;
    Ok(())
}

/// Sign in in the default browser (passkeys, password managers, SSO), the
/// way the CLI and the phone app do: a device login the person approves.
#[tauri::command]
async fn sign_in_with_browser(app: AppHandle) -> Result<(), String> {
    let origin = instance_origin(&app).ok_or("Choose an instance first.")?;
    let flow = Flow::begin(&app);
    let current = |app: &AppHandle| flow.current(app);
    let http = shared(&app).http.clone();
    let instance = Instance {
        http: &http,
        origin: &origin,
    };
    let fail = |app: &AppHandle, message: String| {
        set_screen(
            app,
            Screen::SignIn {
                instance: origin.clone(),
                error: Some(message),
            },
        );
    };

    // Every result that arrives after an await is dropped once another
    // session action began (see `Flow`): it has already shown its own screen.
    let requested = instance.device_code().await;
    if !current(&app) {
        return Ok(());
    }
    let grant = match requested {
        Ok(grant) => grant,
        Err(error) => {
            fail(&app, error.message());
            return Ok(());
        }
    };
    set_screen(
        &app,
        Screen::BrowserSignIn {
            instance: origin.clone(),
            user_code: grant.user_code.clone(),
            verification_url: grant.verification_url.to_string(),
        },
    );
    let _ = app
        .opener()
        .open_url(grant.verification_url.as_str(), None::<&str>);

    let deadline = tokio::time::Instant::now() + grant.expires_in;
    let mut interval = grant.interval;
    while tokio::time::Instant::now() < deadline {
        // Polling sooner than the server's interval earns `slow_down` and a
        // longer wait, so `hatch://` from the browser does not shorten it.
        tokio::time::sleep(interval).await;
        if !current(&app) {
            return Ok(());
        }
        let polled = instance.device_poll(&grant.device_code).await;
        if !current(&app) {
            return Ok(());
        }
        match polled {
            Ok(DevicePoll::Pending | DevicePoll::Unavailable) => {}
            Ok(DevicePoll::SlowDown) => interval += std::time::Duration::from_secs(5),
            Ok(DevicePoll::Approved(token)) => {
                if let Some(window) = main_window(&app) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Err(error) = keychain::set(&origin, &token) {
                    fail(&app, error);
                    return Ok(());
                }
                restore(app, origin, token, flow).await;
                return Ok(());
            }
            Ok(DevicePoll::Denied) => {
                fail(&app, "The sign-in was declined in the browser.".into());
                return Ok(());
            }
            Ok(DevicePoll::Expired) => break,
            Err(error) => {
                fail(&app, error.message());
                return Ok(());
            }
        }
    }
    if current(&app) {
        fail(&app, "The browser sign-in expired. Start again.".into());
    }
    Ok(())
}

#[tauri::command]
fn cancel_sign_in(app: AppHandle) {
    Flow::begin(&app);
    if let Some(origin) = instance_origin(&app) {
        set_screen(
            &app,
            Screen::SignIn {
                instance: origin,
                error: None,
            },
        );
    }
}

#[tauri::command]
fn change_instance(app: AppHandle) {
    Flow::begin(&app);
    let instance = instance_origin(&app);
    set_screen(
        &app,
        Screen::Connect {
            instance,
            error: None,
        },
    );
}

#[tauri::command]
async fn retry(app: AppHandle) {
    start(app).await;
}

#[tauri::command]
fn open_instance_in_browser(app: AppHandle) {
    if let Some(origin) = instance_origin(&app) {
        let _ = app.opener().open_url(origin, None::<&str>);
    }
}

// ---------------------------------------------------------------------------
// Commands from the instance's pages: native Apps (see `native::session`)

/// The signed-in instance, for native Apps: only while the window shows it.
fn native_instance(app: &AppHandle) -> Option<native::session::Instance> {
    if !matches!(*shared(app).screen.lock().unwrap(), Screen::Instance) {
        return None;
    }
    let (origin, token, user) = shared(app).session.lock().unwrap().clone()?;
    if instance_origin(app).as_deref() != Some(origin.as_str()) {
        return None;
    }
    native::session::Instance::new(app, &origin, &token, &user, &user_agent(app))
}

#[tauri::command]
async fn native_app_open(
    app: AppHandle,
    request: native::session::OpenRequest,
) -> Result<(), String> {
    let instance = native_instance(&app).ok_or("Not signed in.")?;
    tauri::async_runtime::spawn(native::session::open(app, instance, request));
    Ok(())
}

#[tauri::command]
fn native_app_place(
    app: AppHandle,
    key: String,
    rect: native::view::CssRect,
    viewport_width: f64,
    visible: bool,
) {
    let for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        native::session::place(&for_main, &key, rect, viewport_width, visible)
    });
}

#[tauri::command]
fn native_app_cover(app: AppHandle, key: String, covered: bool) {
    let _ = app.run_on_main_thread(move || native::session::cover(&key, covered));
}

#[tauri::command]
async fn native_app_snapshot(app: AppHandle, key: String) -> Result<tauri::ipc::Response, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(native::session::snapshot(&key));
    })
    .map_err(|e| e.to_string())?;
    let png = rx
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No picture of this App.")?;
    Ok(tauri::ipc::Response::new(png))
}

#[tauri::command]
fn native_app_focus(app: AppHandle, key: String) {
    let for_main = app.clone();
    let _ = app.run_on_main_thread(move || native::session::focus(&for_main, &key));
}

#[tauri::command]
async fn native_app_message(app: AppHandle, key: String, message: native::session::SurfaceMessage) {
    let instance = native_instance(&app);
    native::session::message(app, instance, key, message).await;
}

#[tauri::command]
fn native_app_close(app: AppHandle, key: String) {
    let _ = app.run_on_main_thread(move || native::session::close(&key));
}

// ---------------------------------------------------------------------------
// Links, menu, navigation

fn open_externally(app: &AppHandle, url: &Url) {
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("hatch: could not open {url}: {error}");
    }
}

fn handle_deep_link(app: &AppHandle, raw: &str) {
    let Some(link) = deep_link::parse(raw) else {
        eprintln!("hatch: ignored malformed link");
        return;
    };
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let origin = instance_origin(app);
    if let Some(named) = &link.instance {
        if origin.as_deref() != Some(named) {
            // Another instance: its own web UI, in the browser.
            if let Ok(url) = Url::parse(named).and_then(|base| base.join(&link.path)) {
                open_externally(app, &url);
            }
            return;
        }
    }
    let screen = shared(app).screen.lock().unwrap().clone();
    // `hatch://` alone names the start page. The approval page uses it to
    // send the person back from the browser; it only brings the app forward.
    if link.path == "/" && !matches!(screen, Screen::Instance) {
        return;
    }
    let showing_instance = matches!(screen, Screen::Instance);
    match (origin, showing_instance, main_window(app)) {
        (Some(origin), true, Some(window)) => {
            if let Ok(url) = Url::parse(&origin).and_then(|base| base.join(&link.path)) {
                let _ = window.navigate(url);
            }
        }
        _ => *shared(app).pending_path.lock().unwrap() = Some(link.path),
    }
}

/// Sends a command to the page (see `src/components/desktop-host/host.ts`).
fn page_command(app: &AppHandle, command: serde_json::Value) {
    if !matches!(*shared(app).screen.lock().unwrap(), Screen::Instance) {
        return;
    }
    if let Some(window) = main_window(app) {
        // The sidebar shell cancels the event when it handles it. Pages
        // outside the shell (sign-in, not found) have no handler, so a
        // destination then loads as a plain navigation.
        let fallback = match command.get("type").and_then(|value| value.as_str()) {
            Some("navigate") => format!("location.assign({})", command["to"]),
            _ => String::new(),
        };
        let _ = window.eval(format!(
            "if (window.dispatchEvent(new CustomEvent('hatch:desktop-command', {{ cancelable: true, detail: {command} }}))) {{ {fallback} }}"
        ));
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let navigate = |to: &str| page_command(app, json!({ "type": "navigate", "to": to }));
    match id {
        "settings" => navigate("/settings"),
        "new-session" | "go-agent" => navigate("/agent"),
        "go-desk" => navigate("/dashboard"),
        "go-apps" => navigate("/apps"),
        "go-notifications" => navigate("/notifications"),
        "search" => page_command(app, json!({ "type": "focus-search" })),
        "toggle-sidebar" => page_command(app, json!({ "type": "toggle-sidebar" })),
        "back" | "forward" => {
            if let Some(window) = main_window(app) {
                let _ = window.eval(if id == "back" {
                    "history.back()"
                } else {
                    "history.forward()"
                });
            }
        }
        "zoom-in" | "zoom-out" | "zoom-actual" => {
            let state = shared(app);
            let factor = {
                let mut zoom = state.zoom.lock().unwrap();
                *zoom = match id {
                    "zoom-in" => (*zoom * 1.1).min(3.0),
                    "zoom-out" => (*zoom / 1.1).max(0.5),
                    _ => 1.0,
                };
                *zoom
            };
            if let Some(window) = main_window(app) {
                let _ = window.set_zoom(factor);
            }
        }
        "reload" => {
            if let Some(window) = main_window(app) {
                let _ = window.reload();
            }
        }
        "show-main" => {
            if let Some(window) = main_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "open-in-browser" => {
            let showing_instance = matches!(*shared(app).screen.lock().unwrap(), Screen::Instance);
            let page = main_window(app).and_then(|window| window.url().ok());
            match (showing_instance, page, instance_origin(app)) {
                (true, Some(url), Some(origin)) if policy::on_instance(&origin, &url) => {
                    open_externally(app, &url)
                }
                (_, _, Some(_)) => open_instance_in_browser(app.clone()),
                _ => {}
            }
        }
        "help-instance" => open_instance_in_browser(app.clone()),
        "sign-in" => {
            let signed_out = matches!(*shared(app).screen.lock().unwrap(), Screen::SignIn { .. });
            if signed_out {
                tauri::async_runtime::spawn(sign_in_with_browser(app.clone()));
            }
        }
        "sign-out" => {
            tauri::async_runtime::spawn(sign_out(app.clone()));
        }
        "switch-instance" => {
            if let Some(window) = main_window(app) {
                let _ = window.clear_all_browsing_data();
            }
            change_instance(app.clone());
        }
        #[cfg(any(debug_assertions, feature = "probes"))]
        "probe-native-over" | "probe-native-beside" => {
            if let Some(window) = main_window(app) {
                let placement = if id == "probe-native-over" {
                    probes::Placement::Over
                } else {
                    probes::Placement::Beside
                };
                if let Ok(ns_window) = window.ns_window() {
                    unsafe { probes::toggle_native_panel(ns_window, placement) };
                }
            }
        }
        #[cfg(any(debug_assertions, feature = "probes"))]
        "probe-passkey" => {
            if let Some(window) = main_window(app) {
                let _ = window.eval(probes::PASSKEY_PROBE_SCRIPT);
            }
        }
        _ => {}
    }
}

/// The policy for the window's own page (see `policy`), with its effects.
fn decide_navigation(app: &AppHandle, navigation: &webkit::Navigation) -> bool {
    if navigation.new_window {
        // Tauri's `on_new_window` decides (see `create_window`).
        return true;
    }
    if !navigation.main_frame {
        return policy::allow_subframe(&navigation.url);
    }
    let instance = instance_origin(app);
    let showing_bundled = navigation
        .current_url
        .as_deref()
        .is_none_or(|url| url.is_empty() || url.starts_with("tauri:"));
    let requested = navigation.url.starts_with("tauri:")
        && shared(app).bundled_requested.swap(false, Ordering::SeqCst);
    match policy::decide_top_level(
        instance.as_deref(),
        &navigation.url,
        showing_bundled,
        requested,
    ) {
        policy::TopLevel::Allow => true,
        policy::TopLevel::OpenExternally(url) => {
            // Only a click opens another app; scripts cannot.
            if navigation.user_initiated {
                open_externally(app, &url);
            }
            false
        }
        policy::TopLevel::DeepLink(raw) => {
            handle_deep_link(app, &raw);
            false
        }
        policy::TopLevel::Deny => false,
    }
}

/// The page's theme colour changed: the window takes the theme's appearance.
fn on_theme_color(app: &AppHandle, color: Option<webkit::Rgb>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.set_theme(Some(appearance::theme_for(color)));
    let _ = window.set_background_color(Some(appearance::background_for(color, GROUND)));
}

fn unique_download_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let name = std::path::Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .unwrap_or("download");
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) => (stem, format!(".{extension}")),
        None => (name, String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){extension}")))
        .find(|path| !path.exists())
        .unwrap()
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let for_new_window = app.clone();
    let for_downloads = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Hatch")
        .inner_size(1240.0, 780.0)
        .min_inner_size(880.0, 560.0)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(18.0, 20.0))
        .background_color(GROUND)
        .user_agent(&user_agent(app))
        // Nothing the page stores outlives the app; the session is restored
        // from the Keychain at launch.
        .incognito(true)
        .visible(false)
        .on_page_load(|window, payload| match payload.event() {
            // A new page (a reload, or another instance page loaded whole)
            // never closes the surfaces of the one it replaces.
            PageLoadEvent::Started => {
                let _ = window.run_on_main_thread(native::session::close_all);
            }
            PageLoadEvent::Finished => on_page_load(&window, payload.url()),
        })
        .on_new_window(move |url, _features| {
            match policy::decide_new_window(url.as_str()) {
                policy::TopLevel::OpenExternally(url) => open_externally(&for_new_window, &url),
                policy::TopLevel::DeepLink(raw) => handle_deep_link(&for_new_window, &raw),
                _ => {}
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            if let DownloadEvent::Requested { destination, .. } = event {
                let Ok(dir) = for_downloads.path().download_dir() else {
                    return false;
                };
                let name = destination.to_string_lossy().into_owned();
                *destination = unique_download_path(&dir, &name);
            }
            true
        })
        .build()?;

    let app = app.clone();
    window.with_webview(move |webview| unsafe {
        let for_proxy = app.clone();
        webkit::install_navigation_proxy(
            webview.inner(),
            Box::new(move |navigation| decide_navigation(&for_proxy, navigation)),
        );
        let for_url = app.clone();
        webkit::observe_url(
            webview.inner(),
            Box::new(move |url| on_url_change(&for_url, &url)),
        );
        webkit::observe_theme_color(
            webview.inner(),
            Box::new(move |color| on_theme_color(&app, color)),
        );
    })?;
    Ok(window)
}

/// Developer builds print NSH's log (the App's errors) to stderr.
#[cfg(debug_assertions)]
struct StderrLog;

#[cfg(debug_assertions)]
impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}

pub fn run() {
    #[cfg(debug_assertions)]
    {
        static LOGGER: StderrLog = StderrLog;
        let _ = log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_screen,
            connect,
            sign_in_with_browser,
            cancel_sign_in,
            change_instance,
            retry,
            open_instance_in_browser,
            native_app_open,
            native_app_place,
            native_app_cover,
            native_app_snapshot,
            native_app_focus,
            native_app_message,
            native_app_close,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings_file = SettingsFile::new(app.path().app_config_dir()?);
            let settings = settings_file.load();
            app.manage(Shared {
                settings_file,
                settings: Mutex::new(settings),
                screen: Mutex::new(Screen::Working {
                    instance: None,
                    message: String::new(),
                }),
                http: api::client(&user_agent(&handle)),
                pending_path: Mutex::new(None),
                completion: Mutex::new(None),
                bundled_requested: AtomicBool::new(false),
                flow: AtomicU64::new(0),
                zoom: Mutex::new(1.0),
                session: Mutex::new(None),
            });

            app.set_menu(menu::build(&handle)?)?;
            native::session::install_shortcut_monitor(&handle);
            // Native Apps are TSX: every engine serves all of `nsh/base`, as
            // the web player does.
            nsh_platform_macos::set_ui_sets(vec![nsh_base::registry()]);
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

            let window = create_window(&handle)?;
            window.show()?;

            if let Ok(Some(urls)) = handle.deep_link().get_current() {
                if let Some(url) = urls.last() {
                    handle_deep_link(&handle, url.as_str());
                }
            }
            let links = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&links, url.as_str());
                }
            });

            tauri::async_runtime::spawn(start(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app (and its session) running, as
            // on any Mac app; the Dock icon or ⌘0 brings it back.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Hatch failed to start")
        .run(|app, event| {
            if let RunEvent::Reopen { .. } = event {
                if let Some(window) = main_window(app) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
