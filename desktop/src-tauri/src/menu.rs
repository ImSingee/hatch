//! The application menu: the standard macOS items plus Hatch's sections.
//! Item ids are the commands `lib.rs` runs.

use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        MenuItem::with_id(app, id, text, true, accelerator)
    };
    let separator = || PredefinedMenuItem::separator(app);

    let about = AboutMetadata {
        name: Some("Hatch".into()),
        version: Some(app.package_info().version.to_string()),
        copyright: None,
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "Hatch",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Hatch"), Some(about))?,
            &separator()?,
            &item("settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &separator()?,
            &item("sign-in", "Sign In with Browser…", None)?,
            &item("switch-instance", "Switch Instance…", None)?,
            &item("sign-out", "Sign Out", None)?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("new-session", "New Agent Session", Some("CmdOrCtrl+N"))?,
            &separator()?,
            &item(
                "open-in-browser",
                "Open in Browser",
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    // WKWebView needs these for copy, paste and undo to work in pages.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &separator()?,
            &item("search", "Search Apps", Some("CmdOrCtrl+K"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+Ctrl+S"))?,
            &separator()?,
            &item("reload", "Reload", Some("CmdOrCtrl+R"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &item("back", "Back", Some("CmdOrCtrl+["))?,
            &item("forward", "Forward", Some("CmdOrCtrl+]"))?,
            &separator()?,
            &item("go-desk", "Desk", Some("CmdOrCtrl+1"))?,
            &item("go-agent", "Agent", Some("CmdOrCtrl+2"))?,
            &item("go-apps", "All Apps", Some("CmdOrCtrl+3"))?,
            &item("go-notifications", "Notifications", Some("CmdOrCtrl+4"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &separator()?,
            &item("show-main", "Hatch", Some("CmdOrCtrl+0"))?,
        ],
    )?;

    #[cfg(any(debug_assertions, feature = "probes"))]
    let develop = Some(Submenu::with_items(
        app,
        "Develop",
        true,
        &[
            &item("probe-native-over", "Native View Over Page (B1)", None)?,
            &item("probe-native-beside", "Native Panel Beside Page (B1)", None)?,
            &separator()?,
            &item("probe-passkey", "Check Passkey Support (B2)", None)?,
        ],
    )?);
    #[cfg(not(any(debug_assertions, feature = "probes")))]
    let develop: Option<Submenu<R>> = None;

    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view, &go, &window])?;
    if let Some(develop) = develop {
        menu.append(&develop)?;
    }
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&item("help-instance", "Open Hatch on the Web", None)?],
    )?;
    menu.append(&help)?;
    window.set_as_windows_menu_for_nsapp()?;
    help.set_as_help_menu_for_nsapp()?;
    Ok(menu)
}
