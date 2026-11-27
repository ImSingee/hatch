fn main() {
    // App commands need a permission like any plugin command, so only the
    // capabilities that list them (the bundled page's) can call them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_screen",
            "connect",
            "sign_in_with_browser",
            "cancel_sign_in",
            "change_instance",
            "retry",
            "open_instance_in_browser",
            "native_app_open",
            "native_app_place",
            "native_app_cover",
            "native_app_snapshot",
            "native_app_focus",
            "native_app_message",
            "native_app_close",
        ]),
    ))
    .expect("tauri build");
}
