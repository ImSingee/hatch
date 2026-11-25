# Native App runtime

How an App with `app.runtime: 'native'` is built, served and hosted. The
frontend is NSH TSX ([nsh.dev](https://nsh.dev)) instead of a React page; the
backend, proto, Data Tables, widgets and the rest of the manifest are the same
as for a `web` App. This document is the contract for anyone writing a shell
that runs these Apps (the web player today; the iOS, Android and macOS shells
later) and for the UI library that Apps import. The plan behind it is
[native-app-ui-plan.md](native-app-ui-plan.md).

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

## Toolchain

The platform runs one pinned NSH release, `NSH_VERSION` in
`src/server/apps/native/nsh-toolchain.ts` (0.6.1). It finds `nsh` at
`HATCH_NSH_BIN`, then on `PATH`, `~/.local/bin`, `~/.nsh/bin` and
`/opt/nsh/bin`, and refuses any binary whose `nsh --version` differs; the
error says how to install the pinned release. The Docker image installs the
Linux CLI and the web runtime component from the GitHub release, each checked
against a SHA-256 (`Dockerfile`, `nsh` stage; CI installs from the same pin).
`nsh check` uses the platform's own TypeScript 7 (`NSH_TSC`), so deploys never
download a compiler; NSH's cache lives in `<HATCH_DATA_DIR>/cache/nsh`.

Upgrading NSH is a deliberate change: read NSH's compatibility notes, update
the version and every SHA-256 (the `Dockerfile` ARGs and
`NSH_RELEASE_SHA256`; a test compares them), rebuild the UI library, run the
catalogue screenshots on every shell, and keep serving the old web runtime for
deployments built with the old version (the runtime store below keeps every
version's files).

## Build and deploy check

`buildApp` (`src/server/apps/build.ts`) hands a native frontend to
`buildNativeFrontend` (`src/server/apps/native/build-native.ts`) after the
existing source steps (install, SDK, Connect codegen, the toolchain check of
backend, widgets and schema). In the disposable build copy it:

1. Writes `nsh.json` at the App root and `app/tsconfig.json` next to the
   entry. Both are generated, never authored: an authored root `nsh.json` or
   `app/tsconfig.json` is overwritten, any other `nsh.json` fails the deploy,
   and `.nsh/` caches are removed. `nsh.json` holds the grant, one exact alias
   per SDK entry (`NATIVE_APP_SDK_DEFINITIONS` in
   `sdk-internal/definitions.ts`), `appearance: light`, the theme and, when the
   UI library contributes one, its `tailwind` extension.
2. `nsh check app/main.tsx`: types, including token names.
3. Source rules NSH does not enforce (`source-rules.ts`), over the App files
   the entry reaches:
   - outside `app/custom/`, no import of `nsh` or `nsh/*`;
   - no bare colours: arbitrary Tailwind colour values (`bg-[#f00]`) and
     Tailwind palette classes (`bg-red-500`, `text-white/80`) in any string,
     and colour literals given to colour style keys (`color`,
     `*Color`, `fill`, `stroke`, `fillStyle`, `strokeStyle`);
   - no call of a streaming RPC method on a Connect client of the service
     that declares it (`client.watchThings(...)` after
     `const client = createClient(ThingsService, transport)`, or
     `createClient(ThingsService, t).watchThings(...)`): the bridge carries
     unary calls. A same-named method on anything else is not a finding; a
     client passed on under another name is not followed, and its streaming
     calls fail at run time with `unimplemented`.
4. `nsh build --release`; a warning about an unknown class fails the deploy.
5. Start-up check: `nsh test app/main.tsx --web-host <canned host>`. NSH opens
   the App headless for about 1.2 s; a throw while rendering or starting fails
   the deploy. This runs App code on the server, so it runs under the sandbox
   identity (refused in production without it, like manifest evaluation),
   with the generated grant (no network, files or URLs), a canned host that
   answers `hatch.rpc` with empty messages and `hatch.data.query` with no
   rows, and a 60 s limit.
6. `nsh package --target web` links the App's module for the web player.

Every failure names App-relative files and lines (`app/main.tsx:12:7`). A
failed build is an `AppBuildError` (`src/server/apps/build.ts`): the public
deploy RPC rejects it as `BAD_REQUEST` with the build output as its message,
so `hatch app deploy` exits 2 and prints it, and nothing was released.

Outputs, in the deployment's `app/` directory:

| File                                                                                  | What                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                                                          | The player page (below).                                                                                                  |
| `player.js`, `player.css`, `fonts.css`, `fonts/`                                      | The player script (`@hatch/app/native/player`, bundled per deployment) and the Desk fonts under the names the theme uses. |
| `web/app.<digest>.js`, `web/facades/`, chunks, assets                                 | The App's linked module for the web runtime.                                                                              |
| `bundle.js`, `native/bundle.nshc`, `native/bundle.js.map`, `native/capabilities.json` | The release bundle native shells will load (packaged and signed in a later phase).                                        |

`nsh package` links each App its own engine, but every runtime file it writes
is named by its content. The build publishes those files (the runtime module,
the engine `.wasm`, side modules, data files and `browser.<digest>/`, with
their `.br`/`.gz` copies) to `<HATCH_DATA_DIR>/app-runtime/nsh/<version>/`,
write-once: an existing name must hold the same bytes. Apps with the same
engine share the download.

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
and `appId: dev.hatch.app.<app id>` (which scopes NSH storage per App).

Trust model: NSH does not isolate an App from its page on the web, and the
page is same-origin with the platform, as a `web` App's page is. The CSP
narrows what the App can load or reach to the platform origin. Moving App
pages to their own origin is later work.

## Host bridge

A native App holds no credentials and no network grant. It reaches the
platform only through `host.call(name, args)`, answered by the shell with its
own session. The grant is exactly these names (plus, later, the
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
  answers `events: []` if none came; while the App is hidden it answers
  `events: []` after the wait without a request, and the App's cursor makes it
  catch up when shown. `@hatch/app/native` treats an empty answer that comes
  back within a second (an empty proxy response) as a dropped stream, so the
  Data Table watch backs off before polling again.
- Events the shell sends (`player.hostEvent` on the web): `hatch.theme`
  `{ theme }`, `hatch.nav` `{ route }`, `hatch.visibility` `{ visible }`,
  `hatch.update` `{}`.
- Start parameters (`host.params`): `{ route }`.

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

`nshTheme(accent)` (`src/server/apps/native/nsh-theme.ts`) is the theme every
shell applies: the UI library's own complete theme when a definition in
`NATIVE_APP_SDK_DEFINITIONS` provides `nsh.theme`, otherwise the shadcn
tokens filled from `packages/hatch-design-tokens/tokens.json` with `primary`
from the accent. `nsh.json` gets the default accent's theme; the player gets
one per accent and pushes `hatch.theme` when the surface reports a new
accent, so `hatch theme set --accent teal` recolours open Apps without a
redeploy.
