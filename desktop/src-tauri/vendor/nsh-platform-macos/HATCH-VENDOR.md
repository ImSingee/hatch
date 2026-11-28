# Vendored `nsh-platform-macos` 0.7.0 with upstream fix a63b867

This is the macOS backend of NSH (Native Shell) by Longbridge, as published on
crates.io, used by the Hatch macOS app through `[patch.crates-io]` in
`desktop/src-tauri/Cargo.toml`. It is licensed under the Apache License,
Version 2.0 (`LICENSE-APACHE`, the license file of the same NSH release).

- Crate: `nsh-platform-macos` 0.7.0,
  <https://static.crates.io/crates/nsh-platform-macos/nsh-platform-macos-0.7.0.crate>
- Archive SHA-256: `2b91b4ec02d9eec10020d6610344b6c6ac04c039a3e9711581a063fd248ca1c1`
- Upstream commit of the release: `3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359`
  (`crates/nsh-platform-macos`, see `.cargo_vcs_info.json`)

## The change

`src/app.rs` carries upstream commit
`a63b8670bc60864125c8992667ab5eef205d76b2` (longbridge/nsh#3528, which fixes
longbridge/nsh#3514), merged after 0.7.2. Its hunks apply to 0.7.0 unchanged,
at the same lines:

```diff
@@ -477,7 +477,7 @@
             cache: options.cache.clone(),
             storage: options.storage.clone(),
             clock: Default::default(),
-            context: Default::default(),
+            context: self.root_context(),
             pinned: Default::default(),
             clipboard: None,
             host: options.host.clone(),
@@ -501,6 +501,18 @@
         self.surface.start(config);
     }
 
+    /// An embedded view (not [`run_app`]'s) mounts a plain JS root in itself,
+    /// as it does a Rust app, rather than in an implicit `main` window of its
+    /// own (#3514). The app's `<Window>`s still open windows.
+    fn root_context(&self) -> nsh_core::element::EngineContext {
+        let context = nsh_core::element::EngineContext::default();
+        #[cfg(feature = "js")]
+        if !self.surface.standalone.get() {
+            return nsh_engine::with_inline_root(context);
+        }
+        context
+    }
+
     /// Where `asset:/` URIs resolve from now on.
     pub fn set_asset_base(&self, base: Option<AssetBase>) {
         self.options.borrow_mut().asset_base = base;
```

The commit's other files (a native test and a page of NSH's developer docs)
are not part of the published crate. Every other file here is the crate's,
byte for byte; this note and `LICENSE-APACHE` are the only additions.
`pnpm nsh:vendor:check` (run in CI) downloads the crate and the upstream file
before and after the commit, checks their SHA-256, compares every other file
and requires `diff -u` of `src/app.rs` against 0.7.0 to equal the commit's
`diff -u`, context and line numbers included.

## Why

An `AppView` embeds one NSH engine in a host's window. Up to 0.7.2 it starts
the engine with an empty `EngineContext`, and on a desktop OS NSH then wraps a
JS App's root in an implicit main window of its own (`nsh-js` `dom.rs`:
`windowed = !inline_root && os.is_desktop()`). The App opens as a separate
window and the embedded view stays empty. The fix marks the context of every
view but `run_app`'s standalone one with `nsh_engine::with_inline_root`, so
the root draws in the view. Hatch only embeds `AppView`s.

## Removing it

When Hatch moves to the first NSH release that contains commit `a63b867`
(`src/server/apps/native/nsh-toolchain.ts` and every `=0.7.x` pin in
`desktop/src-tauri/Cargo.toml`), the behavior stays the same without this
copy:

1. Delete this directory and the `[patch.crates-io]` section of
   `desktop/src-tauri/Cargo.toml`.
2. Remove `nsh:vendor:check` from `package.json` and CI, and
   `scripts/check-vendored-nsh.ts`.
3. Build the app and check that a native App draws inside the window, not in
   a window of its own.
