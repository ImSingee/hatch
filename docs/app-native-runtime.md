# Native App runtime

How an App with `app.runtime: 'native'` is built, served and hosted. The
frontend is NSH TSX ([nsh.dev](https://nsh.dev)) instead of a React page; the
backend, proto, Data Tables, widgets and the rest of the manifest are the same
as for a `web` App. This document is the contract for anyone writing a shell
that runs these Apps (the web player today; the iOS, Android and macOS shells
later) and for the UI library that Apps import.

## Manifest

```ts
app: { entry: 'app/main.tsx', runtime: 'native', routes: [...] }
```

- `runtime` is optional; `web` is the default and the only value older
  manifests have. Unknown values are rejected. A native App has no `html`.
- The entry must sit directly in `app/`. Files under `app/custom/` may use
  `nsh` directly (canvases, games); every other App file takes its UI from
  the catalogue library.
- No compatibility version changes: the runtime is read per deployment from
  `manifestNormalized.app.runtime` (`'native'`, absent for `web`), next to
  `app.nshVersion`, the NSH release it was built with. Rollback between a
  `web` and a `native` deployment works because each deployment carries its
  own runtime.

`hatch app get` reports both as `frontend.runtime` and `frontend.nshVersion`.

`templates/default-app` is native, so every App `hatch app create` makes
starts on this runtime with `@hatch/ui`; the manifest default stays `web`,
so existing and imported Apps keep their runtime.

## UI library

`@hatch/ui` (`sdk-internal/ui`) is a source-form SDK (`form: 'source'` on
`UI_SDK` in `sdk-internal/definitions.ts`): `pnpm hatch-sdk:build` copies
`src/` to `dist/` byte for byte, because NSH compiles the library with the
App, and its entry is `runtime: 'native'`, so it is in `nsh.json` and never in
the web/Deno import map or `.hatch/tsconfig.json`. Its `nsh` field supplies
the theme (`buildAppTheme`) and the Tailwind extension every native App gets.

The library keeps the App's address and title in the shell itself
(`src/core/shell.ts`): `AppShell`'s selected section is the first segment of
the route and a `NavStack` given `routes` maps its pages to the rest; both
start from `host.params.route`, report with `hatch.nav.setRoute` and follow
`hatch.nav`; the title of the deepest shown `Page` goes to
`hatch.nav.setTitle`. Hidden content (an unselected section, a page under the
top of its stack) reports neither.

## Checkouts

A native App's checkout gets the same generated files a deploy writes. The
SDK payload (`SdkService/GetSdk`) carries `.hatch/native/nsh.json` (every key
but the App's own) and `.hatch/native/app-tsconfig.json`; the CLI's
preparation adds the App's name, id and entry (`src/app-native-config.ts`),
writes the root `nsh.json` and `app/tsconfig.json`, and lists both and `.nsh/`
in `.git/info/exclude`. `.hatch/tsconfig.native.json` type-checks every other
authored file (backend, widgets, schema). In the Agent's shell, `PATH` holds
the pinned `nsh` and `NSH_TSC` the platform's TypeScript, so its local checks
use the same release and compiler as a deploy.

## Toolchain

The platform runs one pinned NSH release, `NSH_VERSION` in
`src/server/apps/native/nsh-toolchain.ts` (0.7.0). It finds `nsh` at
`HATCH_NSH_BIN`, then on `PATH`, `~/.local/bin`, `~/.nsh/bin` and
`/opt/nsh/bin`, and refuses any binary whose `nsh --version` differs; the
error says how to install the pinned release. The Docker image installs the
Linux CLI and the web runtime component from the GitHub release, each checked
against a SHA-256 (`Dockerfile`, `nsh` stage; CI installs from the same pin).
`nsh check` uses the platform's own TypeScript 7 (`NSH_TSC`), so deploys never
download a compiler; NSH's cache lives in `<HATCH_DATA_DIR>/cache/nsh`. A local
build (`hatch app deploy --local`) needs the same pinned `nsh` on that
machine, found the same way; the CLI passes its pinned TypeScript as
`NSH_TSC` and caches in `~/.cache/hatch/nsh`. The platform accepts a native
package only from that NSH version.

Upgrading NSH is a deliberate change: read NSH's compatibility notes, update
the version and every SHA-256 (the `Dockerfile` ARGs and
`NSH_RELEASE_SHA256`; a test compares them), rebuild the UI library, run the
catalogue screenshots on every shell, and keep serving the old web runtime for
deployments built with the old version. That last part needs no work per
upgrade: a deployment's page, its bundled `player.js` and the runtime
directory its page names (`/api/app-runtime/nsh/<its version>/`) are fixed
when it is built, rollback and activation never rebuild, and the runtime
store below keeps every version's files. The image carries only the pinned
`nsh`; it does not need older releases to serve older deployments. Rolling
an upgrade back is pinning the old version again; deployments built in
between keep the newer runtime the same way.

## Build and deploy check

The deployment build (`buildAppSource` in `src/app-build/produce.ts`, run by
the dedicated Builder or the CLI) hands a native frontend to
`buildNativeFrontend` (`src/app-build/native.ts`) after the existing source
steps (install, SDK, Connect codegen, the toolchain check of backend, widgets
and schema). In the disposable build copy it:

1. Writes `nsh.json` at the App root and `app/tsconfig.json` next to the
   entry. Both are generated, never authored: an authored root `nsh.json` or
   `app/tsconfig.json` is overwritten, any other `nsh.json` fails the deploy,
   and `.nsh/` caches are removed. `nsh.json` holds `entry: app/main.tsx`
   (so NSH takes the App root as the app directory even when `app/` holds an
   `App.tsx`; imports must stay under that directory), the grant, one exact
   alias per SDK entry (`NATIVE_APP_SDK_DEFINITIONS` in
   `sdk-internal/definitions.ts`), `appearance: light`, the theme and, when
   the UI library contributes one, its `tailwind` extension. It never holds
   `dependencies` (NSH modules), which `nsh` would fetch and build with
   Cargo. NSH reads every key it holds: a key NSH does not know would make
   `nsh build` print `warn nsh.json: …`.
2. `nsh check app/main.tsx`: types, including token names.
3. Source rules NSH does not enforce (`source-rules.ts`), over the App files
   the entry reaches, parsed by the platform's TypeScript (JSX-aware, with
   bindings resolved):
   - outside `app/custom/`, no import of `nsh` or `nsh/*`;
   - no namespace import (`import * as base from 'nsh/base'`) or `export *`
     of an `nsh` module, `app/custom/` included: the web player links `nsh`
     imports by name, and such a module deploys but cannot start there
     (type-only forms, `import type * as` and `export type *`, are erased
     and allowed);
   - no bare colours: arbitrary Tailwind colour values (`bg-[#f00]`) and
     Tailwind palette classes (`bg-red-500`, `text-white/80`) in any string
     or template literal (JSX text is not a string), and colour literals
     given to colour style keys (`color`, `*Color`, `fill`, `stroke`,
     `fillStyle`, `strokeStyle`) in objects, JSX attributes and assignments;
   - no call of a streaming RPC method, optional calls included, on a
     Connect client of the service that declares it: a call whose receiver
     binds to `const client = createClient(ThingsService, transport)`, or
     `createClient(ThingsService, t).watchThings(...)`. The bridge carries
     unary calls. A same-named method on anything else, a shadowing local
     included, is not a finding; a client passed on under another name is
     not followed, and its streaming calls fail at run time with
     `unimplemented`.
4. `nsh build --release`; a warning about an unknown class fails the deploy.
5. Start-up check: `nsh test app/main.tsx --web-host <canned host>`. NSH opens
   the App headless for about 1.2 s; a throw while rendering or starting fails
   the deploy. This runs App code, so on the Builder it runs under the sandbox
   identity (refused in production without it, like manifest evaluation),
   with the generated grant (no network, files or URLs), a canned host that
   answers `hatch.rpc` with empty messages and `hatch.data.query` with no
   rows, and a 60 s limit.
6. `nsh package --target web` links the App's module for the web player.
   Every file it writes must be a runtime file, an App file or a file of
   its own page (which the player page replaces); any other file, or a
   referenced file it did not write, fails the build, so a new kind of file
   from an NSH upgrade cannot go unserved.

Source diagnostics (types, source rules, unknown classes, a start-up throw)
name App-relative files and lines (`app/main.tsx:12:7`); other failures name
the step or rule that failed (an entry outside `app/`, a missing toolchain).
A build that rejects the source fails its deployment with `app_build_failed`
and the build output as its message, so `hatch app deploy` exits 2 and prints
it, and nothing was released. A local build that fails for another reason
exits differently: a missing tool or a build that times out or stops without
a result exits 7, and an unexpected error while preparing it exits 6.

The build package carries the release bundle, the App's linked module, its
`nsh package` description and the runtime files. The platform makes the
player from them (`src/server/apps/native/player.ts`): it copies only the
App files the description references, and writes the player script, styles,
fonts, configuration and page itself.

Outputs, in the deployment's `app/` directory:

| File                                                                                  | What                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                                                          | The player page (below).                                                                                                  |
| `player.js`, `player.css`, `fonts.css`, `fonts/`                                      | The player script (`@hatch/app/native/player`, bundled per deployment) and the Desk fonts under the names the theme uses. |
| `web/app.<digest>.js`, `web/facades/`, chunks, assets                                 | The App's linked module for the web runtime.                                                                              |
| `bundle.js`, `native/bundle.nshc`, `native/bundle.js.map`, `native/capabilities.json` | The release bundle native shells will load (packaged and signed in a later phase).                                        |

`nsh package` links each App its own engine, but every runtime file it writes
is named by its content. Packages come from builds the platform does not
trust, so it publishes their runtime files (the runtime module, the engine
`.wasm`, side modules, data files and `browser.<digest>/`, with their
`.br`/`.gz` copies) as one runtime set to
`<HATCH_DATA_DIR>/app-runtime/nsh/<version>/sets/<digest>/`, named by the
SHA-256 over every file name and its bytes, write-once
(`publishRuntimeSet`). No package can replace or add a file another App's
player loads. Deployments share a set only when every runtime file name and
its bytes match, as with the same NSH release and the same side modules. Deployments
built before sets keep their flat `<version>/` files.

## The web player

`/app/<slug>/embed/` serves the deployment's `index.html` for a native App.
Every response of that frame carries

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' blob: data:; font-src 'self' data:; media-src 'self' blob:;
connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none';
frame-ancestors 'self'
```

The page has no inline script. It carries `<meta name="hatch-app-runtime"
content="native">` and its configuration as JSON in `#hatch-player`: App and
deployment ids, the shared runtime's files, the App's module, the grant, the
App's unary RPC methods, its Data API base and one theme per accent.

The player script loads the runtime from `/api/app-runtime/nsh/<version>/`
(no session needed: it is NSH's open-source runtime; `cache-control: public,
max-age=31536000, immutable`, precompressed when accepted), creates the
player, and runs the App's module with `linked: true`, the grant as JSON text
and `appId: dev.hatch.app.<app id>` (which scopes NSH storage per App; `x` and
`-` in the Hatch id are escaped as `x` plus two hex digits, so distinct ids
never share storage).

Code the App imports lazily (`import()`) is a chunk. `nsh package` moves the
`nsh/base` parts only chunks use (pickers, the editor, ...) out of the
engine into side modules (`nsh-<part>.<digest>.wasm`, runtime files); the
page config lists, per chunk, its side modules and fonts, and the player
loads them before the chunk runs (`prepareChunk`), as NSH's own page does.

The App's module, chunks and assets are loaded from
`/app/<slug>/embed/_deployments/<deployment id>/…`, which serves the page's
own deployment from its immutable artifact (`private, max-age=31536000,
immutable`, with the native CSP). A deployment activated while a player
starts or runs therefore cannot take those files away from it; the player
learns of the new deployment as "update available".

Trust model: NSH does not isolate an App from its page on the web, and the
page is same-origin with the platform, as a `web` App's page is. The CSP
narrows what the App can load or reach to the platform origin. Moving App
pages to their own origin is later work.

## Host bridge

A native App holds no credentials and no network grant. Its supported way to
reach the platform is `host.call(name, args)`, answered by the shell with its
own session. On the web this is not an isolation boundary: the NSH grant
governs NSH-managed requests, but the App runs in a page that is same-origin
with the platform (see the trust model above), so shells must not rely on
the bridge to authorize what web App code can reach. The grant is exactly these names (plus, later, the
`hatch.native.*` names of granted capabilities):

| Name                    | Arguments                                                                                                         | Answer (`ok: true`)                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `hatch.rpc`             | `{ service, method, message }`: a unary method of the App's own proto; `message` is Connect JSON (any JSON value) | `{ message, header }`                                             |
| `hatch.data.query`      | `{ body }`: a Data API query                                                                                      | `{ result }`                                                      |
| `hatch.data.mutate`     | `{ body }`: `{ operations }`                                                                                      | `{ result }`                                                      |
| `hatch.data.events`     | `{ table, since }`                                                                                                | `{ events: [{ revision?, reset }] }`, possibly empty after a wait |
| `hatch.theme.get`       | `{}`                                                                                                              | `{ theme }` (NSH `cssVars`)                                       |
| `hatch.nav.setTitle`    | `{ title }` (string up to 256, or null)                                                                           | `{}`                                                              |
| `hatch.nav.setRoute`    | `{ route }`: raw fragment without `#`                                                                             | `{}`                                                              |
| `hatch.nav.open`        | `{ slug, route? }`                                                                                                | `{}`                                                              |
| `hatch.native.supports` | `{}`                                                                                                              | `{ capabilities }` (`[]` on the web)                              |

- Every handler answers with an envelope, `{ ok: true, ... }` or
  `{ ok: false, code, message }` with a Connect code name
  (`invalid_argument`, `not_found`, `unavailable`, ...), because a rejected
  host call reaches the App with its message only.
- Handlers validate every argument and reach only the App's own endpoints:
  `hatch.rpc` posts to `/api/app/<id>/rpc/<service>/<method>` and only for a
  unary method the deployment declared; the data calls go to
  `/api/app/<id>/data/*` with the deployment header.
- A call cannot be cancelled once sent; it ends with its answer or its
  `host.call` timeout. `hatch.data.events` waits up to 25 s for a change and
  answers `events: []` if none came, whether or not the App is shown (the Desk
  stops an App that waits in the background too long instead).
  `@hatch/app/native` treats an empty answer that comes
  back within a second (an empty proxy response) as a dropped stream, so the
  Data Table watch backs off before polling again.
- Events the shell sends (`player.hostEvent` on the web): `hatch.theme`
  `{ theme }`, `hatch.nav` `{ route }`, `hatch.visibility` `{ visible }`,
  `hatch.update` `{}`. NSH keeps an event (up to 256) until the App
  registers a listener for it, so one the shell sends while the App starts
  (an update notice, say) is delivered when the App subscribes; a navigation
  that arrives before the App starts becomes its start route instead.
- Start parameters (`host.params`): `{ route, platform? }`. `platform` is
  `ios` or `android` when the web player runs inside the Mobile app: its
  WebView opens `/app/<slug>/embed/?platform=<os>` and the player passes the
  value on (any other value is dropped). `@hatch/ui` takes that platform's
  look from it; NSH's own `platform.os` wins in a native NSH host, and a
  browser (phones included) keeps the web look.

Apps do not call these names directly. `@hatch/app/native` wraps them:
`followShellTheme`, `initialRoute`, `setRoute`, `onNavigate`, `setTitle`,
`onVisibilityChange`, `onUpdateAvailable`, `openApp`, `nativeSupports` and
`createAppDataClient` (the Data Table client over the bridge).
`@hatch/app/native/rpc` provides `createAppTransport()`, a Connect transport
using the JSON codec over `hatch.rpc`; its `stream` method fails with
`unimplemented`.

## Surface channel

`AppSurface` (`src/components/desk/app-surface.tsx`) keeps reading a `web`
App's frame directly. For a frame whose document has the native meta tag it
posts `{ protocol: 'hatch.app-surface/1', type: 'connect' }` with a
`MessagePort` to the frame's window on the platform origin, and both sides
then use only that port (`sdk-internal/app/src/native-surface.ts`):

- surface to player: `init { route, accent, visible }` first, then
  `navigate { route }`, `theme { accent }`, `visibility { visible }`,
  `update-available` (when a deployment of the App named in `hello`, other
  than its `deploymentId`, is activated);
- player to surface: `hello { appId, deploymentId }`, `route { route }`,
  `title { title }`, `open { slug, route }`.

The player mirrors the route into its own fragment and the title into its
document, so a reload or another reader still finds them. Opened directly
(no surface within 3 s), the player starts from its fragment and the last
accent the browser used. "Update available" is sent when a platform
`app.deployment.activated` event names another deployment of the App than
the one in the frame.

## Theme

`nshThemeFor(resolved)` (`src/server/apps/native/nsh-theme.ts`) turns a
user's resolved theme into the theme every shell applies: the UI library's
own complete theme when a definition in `NATIVE_APP_SDK_DEFINITIONS` provides
`nsh.resolvedTheme` (or, for the built-in `desk`, `nsh.theme(accent)`),
otherwise the shadcn tokens filled from the resolved theme. NSH applies the
`light` block as the theme, so a dark theme's values go there too, and every
theme names the same tokens (`setTheme` replaces the whole theme).

`nsh.json` and the player's built-in themes are `desk` with each accent, for
the first frame and for a platform that does not answer. The player then
reads the viewing user's theme from `GET /api/theme/native`, with no
parameters: the player runs on the platform's origin, so the request carries
the user's session (on the phone, the surface handoff's), and without one the
route answers the default `desk`. No client follows the device's light or
dark setting. `init` and `theme`
messages carry a `themeKey` that changes with the resolved theme. The player
asks again when the surface reports a change and, when it runs alone (the
mobile app's WebView), when the page returns to the foreground, and pushes
`hatch.theme` when the answer differs. A refresh the platform does not answer
is retried after 1, 4 and 15 seconds, and again whenever the App is shown. So `hatch theme set --accent teal` or
`--theme desk-dark` restyles open Apps without a redeploy. Players built before
this (deployments made before themes became data) follow only the accent
until the App is deployed again.
