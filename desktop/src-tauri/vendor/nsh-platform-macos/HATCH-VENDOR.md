# Vendored `nsh-platform-macos` 0.7.0 (one line changed)

This is the macOS backend of NSH (Native Shell) by Longbridge, as published on
crates.io, used by the Hatch macOS app through `[patch.crates-io]` in
`desktop/src-tauri/Cargo.toml`. It is licensed under the Apache License,
Version 2.0 (`LICENSE-APACHE`, the license file of the same NSH release).

- Crate: `nsh-platform-macos` 0.7.0,
  <https://static.crates.io/crates/nsh-platform-macos/nsh-platform-macos-0.7.0.crate>
- Archive SHA-256: `2b91b4ec02d9eec10020d6610344b6c6ac04c039a3e9711581a063fd248ca1c1`
- Upstream commit: `3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359`
  (`crates/nsh-platform-macos`, see `.cargo_vcs_info.json`)

## The change

One line in `src/app.rs`, `AppView::load`:

```diff
-            context: Default::default(),
+            context: nsh_engine::with_inline_root(Default::default()), // Hatch: embedded JS roots draw in this view (see HATCH-VENDOR.md).
```

Every other file is the crate's, byte for byte; this note and
`LICENSE-APACHE` are the only additions. `pnpm nsh:vendor:check` downloads the
crate, checks its SHA-256 and compares every file (CI runs it).

## Why

An `AppView` embeds one NSH engine in a host's window. In 0.7.0 it starts the
engine with an empty `EngineContext`, and on a desktop OS NSH then wraps a JS
App's root in an implicit main window of its own (`nsh-js` `dom.rs`:
`windowed = !inline_root && os.is_desktop()`). The App opens as a separate
window and the embedded view stays empty. `nsh_engine::with_inline_root`
marks the context so the root draws in the view, which is what an embedded
view is for. `AppOptions` has no way to pass the context (0.7.2 neither).

## Removing it

When an NSH release lets an embedding host draw a JS root inline (an
`AppOptions` context, or `AppView` doing it itself), and Hatch moves to that
release (`src/server/apps/native/nsh-toolchain.ts` and every `=0.7.x` pin in
`desktop/src-tauri/Cargo.toml`):

1. Delete this directory and the `[patch.crates-io]` section of
   `desktop/src-tauri/Cargo.toml`.
2. Remove `nsh:vendor:check` from `package.json` and CI, and
   `scripts/check-vendored-nsh.ts`.
3. Build the app and check that a native App draws inside the window, not in
   a window of its own.
