# Native App UI: component library, design rules, themes and native shells

Implementation plan. Status: proposed, not started.

Labels used below: **[fact]** verified in this repository or in the spike,
**[decision]** a choice this plan makes, **[assumption]** must be validated in
Phase 0 before work that depends on it starts.

## 1. Goals, scope and completion criteria

Apps built inside Hatch look inconsistent and never feel native. The root
cause is that an App has no shared UI layer: `templates/default-app` depends on
React, TanStack and an icon set only, so the Agent writes every style from
scratch **[fact]**.

Goals:

1. One component library (`@hatch/ui`) and one written design specification
   that every new App uses, in the spirit of ChatGPT's Intelligent UI: a closed
   catalogue of components the model composes, checked by a machine before it
   ships.
2. Themes as data: a token set stored by the platform, editable by the user,
   applied to every App without changing App code.
3. Apps render with platform widgets on iOS, Android and macOS, and as DOM on
   the web, from one source.
4. Each native shell is one application that runs many deployed Apps: the
   user switches between them without losing state, and on desktop and
   tablet several are visible at the same time.

Scope: Apps generated and deployed inside the platform, and the shell work
needed to run them as described in goal 4. Out of scope: the platform's own UI (chat,
dashboards, settings) stays on Mantine and TanStack Start; Windows and Linux
shells; converting existing React Apps automatically.

Done when:

- A new App created from the default template passes deploy, and the same
  deployment opens in the web UI, the iOS app, the Android app and the macOS
  shell with the same content and the instance theme.
- Changing the theme with `hatch theme set` restyles an open App on every
  shell without a redeploy.
- A deploy whose source uses a colour, size or component outside the catalogue
  fails with a message naming the file and line.
- In the macOS shell and on a tablet, two Apps are visible side by side and
  both stay interactive; on every shell, switching away from an App and back
  returns to the same screen with the same unsaved input.
- Every existing React App keeps deploying, serving and rolling back unchanged.

## 2. Current behaviour and preparation

Current path **[fact]**:

- Manifest: `packages/hatch-manifest/src/app-schema.ts:374-493`. `app` is
  `{ entry, html?, routes }` (`:408-415`). No field names a frontend kind.
- Build runs in the platform server: `buildApp` in
  `src/server/apps/build.ts:819` bundles the frontend with esbuild into
  `out/app/app.js`, inlined into `out/app/index.html` (`:1015-1063`), and each
  widget into `out/widgets/<id>.js` (`:1067-1093`).
- Deploy: `src/server/apps/deploy.ts:471`; the row is inserted at `:893-908`;
  `deployments.version` is an integer that grows per App (`:883-885`).
- Serving: `serveAppAppFile` in `src/server/apps/serve-app.ts:26-73`, reached
  from `/app/$appSlug/embed/` and `/api/app/$appId/app/`.
- Web embedding: `src/routes/_app/app/$appSlug/index.tsx:419-426` is a
  same-origin `<iframe>` with no `sandbox` attribute. No CSP is set for App
  pages.
- App to platform: bundles call `/api/app/<id>/rpc` and the data endpoints with
  the same-origin session cookie (`src/server/apps/runtime-api/rpc.ts:20-60`,
  `data.ts:45-70`).
- Mobile: `mobile/app/apps/[id].tsx` opens the embed URL in an incognito
  WebView after a handoff (`mobile/src/ui/secure-surface.tsx`).
- No desktop shell exists. The Agent has no way to preview an App.
- Settings storage: `platformConfig` key/value registry in
  `src/server/platform-config.ts:39-58`. The closest setting with a full
  RPC and CLI path is `NotificationService.UpdateDestination`.

Technology choice **[decision]**: Native Shell (NSH, `nsh.dev`, Apache-2.0,
v0.6.1). Of the three candidates it is the only one that loads UI at run time
in a sandbox; `mygo` and `asuka` compile the UI into the binary, which cannot
work for Apps generated after the shell is installed.

Spike results **[fact]** (one TSX App, a mock `@hatch/ui`, three hosts):

| Check                     | Web                         | iOS simulator                  | macOS (Rust host)    |
| ------------------------- | --------------------------- | ------------------------------ | -------------------- |
| Loads at run time         | yes (`createPlayer`)        | yes (signed package over HTTP) | yes (signed package) |
| Tampered package          | n/a                         | refused                        | refused              |
| Host bridge data          | yes                         | yes                            | yes                  |
| Ungranted host call       | denied                      | denied                         | denied               |
| Ungranted network request | **not blocked**             | denied                         | denied               |
| App reaches the host page | **yes, via `top.document`** | no                             | no                   |
| Theme change              | live                        | live                           | applied before load  |

Other measured facts: App bundle 4.6 KB, signed package 26 KB, build 28 ms;
web runtime 1.15 MB brotli; `nsh check` caught all three API mistakes in the
first draft; NSH crates need rustc 1.97 or later.

Several Apps in one host **[fact]**, measured on macOS: two engines in one
window kept separate data and separate themes. Resident memory was 85 MB with
one engine and 95 MB with eight, so each further small App costs about
1 to 1.5 MB.

On the web **[fact]**: three players in one document, and three iframes with
one player each, both ran three Apps with separate data, themes and input
state; a hidden pane kept its unsent draft. In one document the first App
was ready in 180 ms and all three in 352 ms, and the runtime was downloaded
once. Not measured: memory per App on the web, and how to tear down one
player cleanly (`player.stop()` returned without removing its views).

Constraints that shape the design:

- NSH does not isolate an App from its host page on the web. The web shell
  must keep its own boundary.
- NSH's trust store refuses a build number lower than the highest it accepted
  for that App. Hatch rollbacks must not hit this (section 3.4).
- NSH is pre-1.0 and ships breaking changes. The runtime version is pinned
  and recorded per deployment (section 6).

Not yet verified **[assumption]**, each a Phase 0 task:

- A1. Android: `nsh.aar` loads the same package with the same sandbox results.
- A2. The NSH bundler resolves `@hatch/ui`, `@hatch/app/*` and the generated
  Connect clients when they are materialised under `.hatch/`.
- A3. Connect unary calls work through a custom transport over `host.call`.
- A4. A package can be signed again with a higher build number without
  rebuilding from source.
- A5. `nsh test` can open an App headless on the server to catch start-up
  errors at deploy.
- A6. `NativeShell.xcframework` and `nsh.aar` link into the Expo app next to
  React Native, and the size increase is acceptable.
- A7. Input methods (CJK composition) and screen readers behave correctly on
  each shell.
- A8. Icons: how `@hatch/ui` ships an icon set (SVG assets or a font).
- A9. Several engines run side by side on iOS and Android as they do on
  macOS, including inside the Expo app.
- A10. What a hidden engine keeps doing (timers, animations) and whether a
  shell can pause it.

If A1 or A6 fails, mobile keeps the WebView and loads the NSH web build
inside it; the component library, theme and deploy checks are unaffected.

## 3. Implementation approach

### 3.1 Two frontend runtimes

`app.runtime` in the manifest selects the runtime: `web` (today's React
bundle, the default when absent) or `native` (NSH TSX) **[decision]**.
Widgets keep the web runtime in this plan and move later (section 11).

A `native` App's source:

```text
app/main.tsx     entry: mounts the root with `mount` from @hatch/ui
app/custom/      optional escape hatch (section 3.3)
```

The frontend has no `index.html` and no npm UI dependencies. The backend,
proto, data schema and manifest are unchanged.

### 3.2 `@hatch/ui`

Lives in `sdk-internal/ui`, materialised into `.hatch/` like `@hatch/app`
(`materializeAppHatchSdk`, `build.ts:869`). Built on `nsh/base`'s unstyled
components and shadcn-style tokens.

Catalogue v1 **[decision]**:

- Layout: `Page`, `Section`, `Stack`, `Row`, `Grid`, `Card`, `Divider`.
- Navigation: `AppShell` (tab bar on phones, sidebar on desktop and wide
  web), `NavStack`, `Tabs`.
- Input: `Button`, `IconButton`, `TextField`, `TextArea`, `NumberField`,
  `Select`, `Combobox`, `Checkbox`, `Switch`, `RadioGroup`, `Slider`,
  `DatePicker`, `Form`, `Field`.
- Display: `Text`, `Heading`, `Badge`, `Avatar`, `List`, `ListItem`,
  `DataTable`, `Stat`, `Progress`, `EmptyState`, `Skeleton`, `Icon`.
- Feedback: `Dialog`, `Sheet`, `AlertDialog`, `Toast`, `Tooltip`, `Menu`.
- Page patterns: `ListDetailPage`, `FormPage`, `SettingsPage`,
  `DashboardPage`.
- State and platform, re-exported so Apps import one package: `signal`,
  `memo`, `effect`, `resource`, `If`, `Each`.

Rules the components enforce:

- No component takes `class` or `style`. Variation is by typed props
  (`tone`, `size`, `gap="md"`), all mapped to tokens.
- Platform differences (navigation pattern, sheet versus dialog, density)
  are decided inside components from `platform.idiom` and from the size of
  the App's own pane. An App in a narrow split pane on a desktop lays out as
  a narrow App, so layout follows the pane, never the screen.
- Every interactive component sets its accessibility role and label.

### 3.3 Design specification and deploy check

The specification is `skills/building-apps/references/design-system.md`:
which pattern to use for which screen, spacing and hierarchy rules, copy
rules, and a catalogue page per component generated from its types.

The deploy check for `native` Apps, added to `buildApp` after the existing
source check:

1. `nsh check`: types, which includes token names.
2. Source boundary: files outside `app/custom/` may import UI only from
   `@hatch/ui` and may not import `nsh` or `nsh/base`; implemented as an
   esbuild-style resolve check next to `browserSourceBoundaryPlugin`
   (`build.ts:670`).
3. `nsh build --release`, with unknown-class warnings promoted to errors.
4. Start-up smoke test (A5).

`app/custom/` is the escape hatch for what the catalogue cannot express
(canvas, games). Files there may use `nsh` directly but still only theme
tokens. The build log lists every custom file so its use stays visible.

### 3.4 Packaging, signing and rollback

- The instance owns a root key and a release key, created on first native
  deploy and stored under `HATCH_DATA_DIR/keys` with owner-only permissions.
- A successful deploy writes `out/app/bundle.js` (web) and the unsigned
  package inputs into the immutable artifact directory.
- The signed `.nshpkg` is produced when a deployment becomes live, by deploy
  or by rollback, with build number = a per-App activation counter that only
  grows **[decision]**. A rollback therefore ships older code under a newer
  build number, and shells accept it. Depends on A4; if A4 fails the package
  is rebuilt from the stored source tag at activation.

What signing does and does not give: it protects integrity in transit and in
the shell's cache, permits bytecode loading, and prevents downgrade. It is
not the security boundary, because a shell trusts the instance its user
signed in to. The boundary is the capability grant in section 9.

### 3.5 The host bridge

A `native` App never receives a credential and is granted no network access.
`@hatch/app` and the generated Connect clients use one transport,
`host.call('hatch.rpc' | 'hatch.data.*', ...)`, and the shell performs the
HTTP request with its own session **[decision]**. Calls:

| Name                                                         | Purpose                                 |
| ------------------------------------------------------------ | --------------------------------------- |
| `hatch.rpc`                                                  | unary Connect call to the App's backend |
| `hatch.data.query`, `hatch.data.mutate`, `hatch.data.events` | Data Tables                             |
| `hatch.theme.get`, event `hatch.theme`                       | current theme and changes               |
| `hatch.nav.setTitle`, `hatch.nav.setRoute`                   | title and deep-link state               |
| `hatch.nav.open`                                             | ask the shell to open another App       |

Streaming RPC is not supported on the native runtime in this plan; the build
rejects a `native` App whose proto declares a streaming method it calls.

### 3.6 Shells: one application, many Apps

A native shell is a container, not a viewer of one App **[decision]**.

Running Apps:

- A running App is one engine with its own bridge channel, grant, storage
  directory and VM limits. Engines share nothing.
- Switching hides an App's view and keeps its engine, so the user returns to
  the same screen and the same unsaved input.
- Opening an App that is already running focuses it. One engine per App per
  shell keeps storage and data subscriptions unambiguous.
- Each shell caps running Apps (starting values: 12 on desktop, 6 on tablet,
  3 on phone) and each engine's heap (96 MB instead of NSH's 256 MB
  default). Over the cap, the least recently shown App is stopped; the shell
  keeps its last `hatch.nav.setRoute` value and reopens it there. Unsaved
  in-memory state of a stopped App is lost, so `@hatch/ui` form components
  persist drafts through App storage.
- The shell stops answering `hatch.data.events` for hidden Apps and resumes
  with a catch-up when they are shown, so background Apps do not poll.
- A new deployment never replaces a running App under the user. The shell
  marks it "update available" and loads the new package on the next open or
  on an explicit reload.

Presentation by form factor:

| Shell  | Switching                                | Visible at once                                                |
| ------ | ---------------------------------------- | -------------------------------------------------------------- |
| macOS  | sidebar of pinned and running Apps, tabs | split panes in a window, and an App can move to its own window |
| Tablet | sidebar or switcher                      | two panes side by side                                         |
| Phone  | switcher sheet                           | one                                                            |
| Web    | the platform's existing navigation       | one in this plan; several planned later                        |

Who owns what: the shell owns App switching, panes, windows, the title bar
and the back gesture between Apps. An App owns navigation inside its pane
through `AppShell` and `NavStack`. `AppShell` uses a top tab row when its
pane is narrow, so a shell sidebar and an App sidebar never sit side by
side.

Per shell:

- **Web.** `/app/$appSlug/embed/` serves a small player page for `native`
  Apps that loads the shared NSH runtime from
  `/api/app-runtime/nsh/<version>/` (long-lived cache) and the App's
  `bundle.js`. The parent page forwards theme changes with `postMessage`.
  The response carries `Content-Security-Policy: connect-src 'self'`.
  Showing several Apps at once on the web is planned later, so nothing here
  may assume one App per page: each App keeps its own iframe and player, the
  embed page takes no state from the surrounding route, and theme and
  visibility reach it only through `postMessage`. The running-App rules
  above (keep alive on switch, cap, pause when hidden) are written so the
  web shell can adopt them unchanged.
- **iOS and Android.** A local Expo module `mobile/modules/hatch-app-view`
  wraps `NshAppView` and `NshView`, and a native session manager owns the
  running engines so they outlive React Native screens. The App screen
  attaches a running engine's view for `native` Apps and keeps
  `SecureSurface` for `web` Apps. The module fetches the package with the
  session bearer, verifies it against the instance root key, grants
  capabilities and implements the bridge. Tablet support is turned on
  (`supportsTablet`, currently false in `mobile/app.config.ts`) with the
  two-pane layout.
- **macOS.** A new Rust crate `desktop/` on `nsh-platform-macos`: device
  login, the session manager, and native pane and window layout holding one
  `AppView` per running App. The shell's own chrome (sidebar, switcher,
  login) is an NSH App bundled with the shell and granted the shell-only
  `shell.*` bridge names, which deployed Apps never receive. The crate pins
  rustc 1.97+ and sets `strip = false` for build dependencies (stripped
  proc-macro libraries fail to load on macOS 27).

### 3.7 Themes

A theme is `{ name, radius, fonts?, light: {...}, dark: {...} }` over a fixed
list of token names. Stored instance-wide under `platformConfig` key
`ui.theme` **[decision]**: Hatch is a single-tenant shared workspace, so
one theme per instance matches how dashboards and pins already work. The key
already holds the platform accent (`{ accent }`, see
[platform-redesign-plan.md](platform-redesign-plan.md) section 3.2); the App
theme extends that value instead of adding a second key.

Built-in presets (`ember`, matching `DESIGN.md`, is the default) plus a
custom token set. Shells force the light appearance for now, matching the
platform; dark values are stored and validated so enabling dark later needs
no data change.

## 4. Database changes

- No new table. Theme: a new registry entry `apps.theme` in
  `src/server/platform-config.ts` with a Zod schema; invalid stored values
  fall back to the `ember` preset.
- `apps`: add `activation_seq integer not null default 0`, incremented in
  the same transaction that changes the live deployment.
- `deployments`: no new column. The runtime kind and NSH runtime version
  are read from `manifestNormalized.app` (`runtime`, `nshVersion`).

## 5. Platform API, CLI and Platform/Runner protocol

Public Connect RPC, all callable with any valid credential:

- `ThemeService.GetAppTheme`, `SetAppTheme`, `ResetAppTheme`,
  `ListAppThemePresets`.
- `AppService.GetAppPackage` (server streaming bytes, or a signed download
  URL) and `AppService.GetAppRuntimeTrust` (root public key, revocations).

CLI in `packages/hatch-cli`, registered in `commands.ts`:

- `hatch theme get [--json]`
- `hatch theme set --preset <name> | --file <path|->` (replaces the whole
  token set; rejects unknown token names and unreadable colours locally)
- `hatch theme reset`
- `hatch theme presets`
- `hatch app package <app> --out <path>` (downloads the live signed package)
- `hatch app get` gains `frontend.runtime` and `frontend.nshVersion`.

Web UI settings and the CLI call the same domain service. No device-bound
exception applies. `docs/cli-tool-parity.md` gets a "Themes" entry.

Platform/Runner protocol: the build runs in the platform server, so no REST
field changes and `PROTOCOL_VERSION` stays 19.

## 6. App package contracts and compatibility

- `app.runtime` is optional and defaults to `web`. Existing manifests parse
  unchanged, so this is a backward-compatible feature and
  `LATEST_APP_COMPATIBILITY_VERSION` is **not** raised.
- The NSH runtime is a second, independent version axis. The platform pins
  one NSH version; a deployment records the version it was built with; a
  shell reports the versions it can run and the platform refuses to hand a
  package to a shell that cannot run it, with an "update the app" message.
- Upgrading the pinned NSH version is a deliberate change with its own
  checklist: read the NSH compatibility record, rebuild `@hatch/ui`, run the
  catalogue screenshot suite on all shells, keep the previous web runtime
  served for deployments built with it.
- Recorded under `Next (proposal)` in `skills/app-compatibility/SKILL.md`:
  making `native` the only runtime for new Apps.

## 7. Historical platform data migration

None. `activation_seq` starts at 0 for every App and is only read for
`native` deployments. No existing row changes meaning.

## 8. Existing App migration

Existing Apps stay on `web`; source, deployments and data are untouched.
Moving an App to `native` is a rewrite of its frontend by the Agent, guided
by a new section in `skills/building-apps`; backend, proto and data carry
over. Rolling back to a `web` deployment after a `native` one works because
the runtime is read per deployment.

## 9. Security and permissions

- Native shells grant each App exactly `{ host: ["hatch.*"] }` and nothing
  else: no network, clipboard, file or URL access. NSH's default when a host
  grants nothing is "whatever the App declares", so the grant is mandatory
  and covered by a test.
- Bridge handlers validate every argument and scope every request to the
  App's own id; `hatch.rpc` can reach only `/api/app/<that id>/rpc`.
- Web: unchanged trust model. A `native` App on the web has the same access
  to the parent page that a React App has today, because both run in a
  same-origin iframe. The new CSP narrows network access. Moving App pages
  to a separate origin is recorded as a follow-up, not part of this plan.
- Signing keys never leave the server; `GetAppRuntimeTrust` returns public
  material only. Key rotation: issue a new release key under the same root
  and re-sign live packages; revoke the old key through the revocation list.
- The `nsh` binary and embed SDKs are pinned by version and SHA-256 in the
  Dockerfile and the mobile and desktop builds.

## 10. Tests and acceptance

Durable tests:

- Manifest: `runtime` parsing, default, and rejection of unknown values.
- Deploy check: one fixture per rule (raw colour, forbidden import,
  streaming RPC, unknown token) fails with file and line; the default
  template passes.
- Activation counter: deploy, deploy, rollback yields three increasing build
  numbers and three packages that verify.
- Bridge: argument validation and cross-App scoping, per shell.
- Capability grant: an App that calls an ungranted host name and an outside
  URL is denied on iOS, Android and macOS.
- Theme: schema rejection, CLI argument mapping, fallback on a corrupt row.
- Session manager: the cap evicts the least recently shown App and reopens
  it at its saved route; opening a running App focuses it instead of
  starting a second engine; a hidden App receives no data events.
- Isolation between running Apps: App A cannot read App B's storage or reach
  B's backend through the bridge, with both running in one shell.
- Compatibility: a `web` App deploys, serves and rolls back as before.

Acceptance, run against a local instance:

| Criterion               | Check                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| One source, four shells | deploy the template; open it on web, iOS, Android, macOS                      |
| Theme without redeploy  | `hatch theme set --preset ...` restyles the open App on each shell            |
| Several Apps            | run two Apps side by side on macOS and a tablet; switch among five on a phone |
| Rollback                | roll back a `native` App; each shell loads the older code                     |
| Catalogue is enforced   | a deploy with a raw colour fails                                              |
| Existing Apps           | an existing React App still opens everywhere                                  |

Every new CLI command is run inside an Agent Run and with a user login.

## 11. Order, dependencies and recovery

0. **Validation.** Resolve A1-A10. Output: a short findings note and a go or
   no-go per shell. Nothing else starts before A2-A4.
1. **Library and web.** `@hatch/ui` catalogue, tokens, the `ember` preset,
   manifest field, build and deploy check, web player, template and skill.
   Shippable alone: new Apps are consistent on the web.
2. **Themes.** Config entry, RPC, CLI, settings panel, live update on web.
3. **Packages and bridge.** Signing, activation counter, package RPC,
   bridge transport in `@hatch/app`.
4. **iOS and Android.** Expo module, session manager, bridge, grants, then
   the tablet two-pane layout. Needs 3 and A1, A6, A9.
5. **macOS.** `desktop/` crate: single App first, then the session manager,
   split panes and separate windows. Needs 3.
6. **Later, separate plans.** Widgets on the native runtime, dark
   appearance, Windows and Linux, a separate origin for App pages,
   several Apps at once in the web UI.

Recovery: each phase is additive and gated by `app.runtime`. Reverting the
default template to `web` stops new native Apps without touching deployed
ones. A broken NSH upgrade is reverted by pinning the previous version; old
web runtimes stay served. No step is irreversible; the only persistent new
state is the signing keys and `activation_seq`.

## 12. Documentation, skills, prompts and templates

- `skills/building-apps/SKILL.md`: the `native` workflow, validation
  commands and the migration section; `references/frontend-widgets.md` is
  split into web and native; new `references/design-system.md`.
- `skills/importing-apps`: imported React Apps stay `web`.
- `templates/default-app`: `native` frontend using `@hatch/ui`; widget
  unchanged.
- System prompt (`src/agent/system-prompt.ts`): one line stating the
  default runtime and pointing to the design specification.
- `DESIGN.md`: the `ember` token values become the single source for both
  Mantine and the App preset.
- `docs/`: `cli-tool-parity.md`, a new `app-native-runtime.md` (package,
  bridge and trust contract for shell authors), `mobile-workspace.md`.
- `README.md` changes are proposed separately for approval, per repository
  rules.
