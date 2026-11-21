# Hatch for macOS

A Tauri 2 app with one window that shows a Hatch instance's own web UI in its
desktop layout. macOS only, light only.

## What is native and what is web

| Native (this folder)                                           | Web (the instance)                                 |
| -------------------------------------------------------------- | -------------------------------------------------- |
| Window, traffic lights, window state, Dock reopen              | Every page: desk, Agent, Apps, Workflows, Settings |
| Application menu and shortcuts (`⌘,` `⌘N` `⌘K` `⌘1`–`⌘5` `⌘[`) | The sidebar (`src/components/desktop-host/`)       |
| First-run page: instance address, sign-in, errors              | Apps, through the same `AppSurface` as on the web  |
| Session in the Keychain, browser sign-in, browser handoff      |                                                    |
| `hatch://` deep links, navigation rules, downloads             |                                                    |

The web UI draws the sidebar layout (the `Mac-App` artboard) instead of the
desk's menu bar and dock when the user agent contains `HatchDesktop/<version>`,
which this app sends. Menu commands reach the page as a
`hatch:desktop-command` event (`src/components/desktop-host/host.ts`). Nothing
here re-implements a page.

## Sign-in and the session

Sign-in always happens in the default browser, so passkeys, password managers
and an existing browser session all work:

1. The app starts a device login (`client_id: "hatch-desktop"`) and opens
   `/cli/authorize` on the instance in the browser.
2. The person approves it there; the page then opens `hatch://`, which brings
   the app back to the front. That link carries nothing.
3. The app receives a session token by polling, checks it with
   `AuthService.GetStatus` and stores it in the Keychain (service
   `app.hatch.desktop.session`, account = instance origin).
4. The window's browser storage is not persistent. At every launch the app
   signs the window in from the Keychain with the platform's browser handoff
   (`AuthService.CreateHandoff`, see `docs/browser-handoffs.md`).

If the instance's own `/login` page appears in the window (signed out in the
page, or the session expired), the app checks the saved session, removes it if
it is gone and shows its own sign-in screen. **Hatch → Sign Out** ends the
session on the instance and removes it from the Keychain.

`settings.json` in `~/Library/Application Support/app.hatch.desktop/` holds
only the instance origin and its accent colour.

Passkeys cannot work inside the window: WKWebView in an app without Apple's
browser entitlement reports no platform authenticator. That is why sign-in is
in the browser.

## What the window may load

`src-tauri/src/policy.rs` holds the rules, with tests:

- The window's page is the configured instance or the bundled first-run page.
  A page of the instance can never navigate to the bundled page.
- Links elsewhere open in the default browser when clicked; scripts cannot
  open other apps. `hatch:` links open as pages of this instance.
- Frames inside a page (Apps embedding maps or videos) load the web as a
  browser would, but never the bundled page or local files.
- New windows (`target=_blank`, `window.open`) open in the default browser.

The instance's pages can call one app command: window dragging. The bundled
page can call only the sign-in commands it uses
(`src-tauri/capabilities/bundled.json`). There is no shell, filesystem or
HTTP plugin.

## Develop

Requires Rust (stable, 1.90 or later), Xcode command line tools, Node and pnpm.
Install from the repository root with `pnpm install`.

```bash
pnpm --dir desktop dev
```

`tauri dev` builds the first-run page and runs the app. For an instance on
this Mac, use a plain `http://localhost:<port>` address; any other address must
be HTTPS. Instances older than this change do not accept the
`hatch-desktop` device client and refuse the browser sign-in.

Deep links work only from a bundled app registered with Launch Services:

```bash
pnpm --dir desktop tauri build --debug --bundles app
```

```bash
open desktop/src-tauri/target/debug/bundle/macos/Hatch.app
```

```bash
open 'hatch://app/<slug>'
```

Debug builds have a **Develop** menu with the probes for the plan's
assumptions: a native AppKit panel over or beside the page (B1), and a
WebAuthn report for the page (B2). Release builds leave them out unless built
with `--features probes`.

Checks:

```bash
pnpm --dir desktop check:types
```

```bash
pnpm --dir desktop test:rust
```

## Build

```bash
pnpm --dir desktop build
```

This writes `Hatch.app` under `desktop/src-tauri/target/release/bundle/macos/`.
A disk image is a separate step, because Tauri lays out the DMG window by
scripting Finder (allow your terminal to control Finder when macOS asks):

```bash
pnpm --dir desktop tauri build --bundles dmg
```

The build is unsigned (ad-hoc), so Gatekeeper blocks it on other Macs; open it
with right-click → Open, or sign and notarise it.

## Signing (not set up)

Signing and notarisation need an Apple Developer ID and are not configured.
Tauri reads `APPLE_SIGNING_IDENTITY` (and, for notarisation, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`) at build time; see
<https://v2.tauri.app/distribute/sign/macos/>. A rebuilt unsigned binary is a
different app to the Keychain, so macOS asks once before it reads a session the
previous build saved.
