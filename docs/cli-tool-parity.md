# App Tool / CLI capability parity

All methods below use Connect RPC under `/api/rpc/hatch.platform.v1`, except
source transfer, which uses Git smart HTTP under `/api/git` (see below).
Tools remain available, and every
valid native session, API key or Run JWT has full public authority. The shared
contract and SDK are shipped with the same platform build. No database migration,
App compatibility bump or protocol-18 wire change is required.

| Original Tool        | CLI                                     | Public API / shared behavior                                                                              |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| list_apps            | app list                                | AppService/ListApps; currentVersion, compatibility, capabilities                                          |
| get_app              | app get                                 | AppService/GetApp; full safe inspection, URLs, runtime, history                                           |
| checkout_app         | app clone / update / adopt              | GetApp, Git fetch (adopt: GetAppSource), SdkService/GetSdk, AssociateAppSession; frozen preparation       |
| create_app           | app create                              | AppService/CreateApp; template, pin, directory, SDK, ID/slug/path/recovery                                |
| deploy_app           | app push / deploy                       | Git push, then AppService/DeployApp by commit; release/URLs, generation, migration approval, association  |
| rollback_app         | app rollback                            | AppService/RollbackApp; compatibility and forward-only data/source recovery                               |
| query_app_db         | app db query                            | AppService/QueryAppDb; registered DB lifecycle lock, DDL/DML, caps/cancellation; no implicit provisioning |
| query_app_kv         | app kv list/get/set/delete              | AppService/QueryAppKv; empty/large UTF-8, masking/reveal, preserve/clear secret, pagination               |
| query_app_data_table | app data-table inspect/query/mutate/sql | AppService/QueryAppDataTable; schema/counts, JSON, cursors/revision, atomic mutations, bounded SQL        |

The capabilities below have no Agent Tool; the CLI is their only Agent
interface.

| Capability       | CLI                                                                                                 | Public API / shared behavior                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App docs         | app docs list / get                                                                                 | AppService/ListAppDocs, GetAppDoc; current deployment's external docs, webhook/RPC endpoints, raw Markdown       |
| App icon         | app icon get / set / clear                                                                          | AppService/GetAppIcon, SetAppIcon (file bytes or candidate id), ClearAppIcon; validated and re-encoded           |
| Image models     | image-model list / add / update / remove                                                            | ImageService/ListImageModels, CreateImageModel, UpdateImageModel, DeleteImageModel; provider keys never exposed  |
| Providers        | provider list / get / catalog / add / update / remove / test / fetch-models                         | ProviderService, CatalogService/ListCatalogProviders; presets, write-only API keys (`hasApiKey`), test prompt    |
| Models           | model list / add / update / enable / disable / remove / set-kind                                    | ModelService; chat and image models, catalog link, chat metadata overrides and resets, kind like the Web field   |
| Model catalog    | model catalog list / status / refresh / settings                                                    | CatalogService/ListCatalogModels, GetCatalogStatus, RefreshCatalog, UpdateCatalogSettings                        |
| Image generation | image generate                                                                                      | ImageService/GenerateImages; 1 to 4 one-day candidates, optional subject/glyph tile composition, hourly cap      |
| Instance theme   | theme get / set                                                                                     | ThemeService/GetTheme, SetTheme; accent (from the design tokens, clients recolour live) and dock labels          |
| Navigation pins  | pin list / add / update / remove / reorder                                                          | PinService; App pins (several per App), dashboard pinned flags, App pin and dashboard order                      |
| Dashboards       | dashboard list / get / create / update / delete, dashboard widget available / add / layout / remove | DashboardService; settings, auto-refresh, widget placement and per-breakpoint layout; `dashboards.updated` event |
| Preferences      | preferences get / set                                                                               | PreferenceService/GetAgentPreferences, UpdateAgentPreferences; queue/steer default, default chat model, thinking |
| Server info      | server info                                                                                         | ServerService/GetServerInfo; commit and commit time of the running server build, as on Settings → About          |

Image models are the provider models of kind `image`; `image-model` keeps
its own commands (backed by `ImageService`), and `model add --kind image`,
`model update` and `model remove` reach the same rows through `ModelService`.
See [App icons](app-icons.md) and the section below.

The Web UI language (Settings → Appearance → Language) is a display preference
of one browser, kept in its local storage and never sent to the server. It is
browser-bound, has no platform state, and therefore has no CLI command.

Source transfer and release are separate. `push` and the fetch behind `clone` /
`update` speak Git smart HTTP at `/api/git/app/<id>.git`; `deploy`
pushes, then calls the Deploy RPC with the commit to release (`--commit`
releases a commit already on `master` without pushing). The Tools keep the
bundle transport: `deploy_app` uploads a bundle that the
platform fast-forwards onto `master` and then releases, and Tool checkouts keep
a local bundle as `origin`. Two deliberate deviations from the CLI rules:

- `push` and source fetch are not backed by a Connect RPC. Git is the public
  contract for source transfer; the endpoint accepts the same credentials as
  the RPCs (session token, API key or Run JWT, with no gate on credential
  type) and associates a pushing Run with its App, as deploy does.
- `git-credential get` prints the current credential although it is not a
  create or rotate command. The Git credential-helper protocol requires it;
  the command only answers for the logged-in platform URL.

CLI extends local checkout output with head/master, dirty/status,
replacedExisting/synchronizedExisting and preparation. Text and JSON modes retain
the complete result. CLI adopts only proven Agent checkout identity/history and
never modifies the original origin or resets dirty source. Empty canonical
source creates a recoverable empty Git checkout, never a second resource.

Preparation covers both build toolchains, selected by the committed lockfile
as on the platform: a `pnpm-lock.yaml` source is reproduced with the same
frozen pnpm install and the platform's pinned `typescript`/`esbuild` versions
from `SdkService/GetSdk`; a `deno.json` + `deno.lock` source keeps the Deno
preparation. The pnpm toolchain adds no command, Agent Tool, public RPC method
or CLI exception; `GetSdk` only gains tool versions and generated files.

The production HTTP/PostgreSQL suite in
`src/server/platform-api/lifecycle.integration.test.ts` calls all nine actual
Tools through the internal REST client and compares public CLI outputs and
resource effects. It also covers session/key/Run auth, full lifecycle, migration
approval and retained data, data commands, and PostgreSQL-observed cancellation.
Workspace concurrency/recovery cases run real child processes/Git in
`packages/hatch-cli/src/workspace.test.ts`. Existing Tool normalization and domain
security/migration regressions remain part of the unit suite. The tests require
an isolated database and a production build; a skipped suite is not evidence.

Local acceptance records should distinguish observed outputs/side effects,
programmatic quality gates, installed-package/container results, and genuinely
untested operating systems. No host credential injection/renewal, Tool removal,
storage/key management or durable operation service is part of this feature.

## Notification center: CLI only, no Agent Tool

`hatch notification ...` (history, test/send/update/recall/delete/respond/retry, sources, APNs status,
destinations, webhooks, groups, routes, response routes and channels) calls
`NotificationService` and has no Agent Tool counterpart because Agent Tools
for platform capabilities are frozen: the platform Agent uses the CLI. The
service accepts sessions, API keys and Run JWTs alike, and every online CLI
command refreshes Run credentials in `packages/hatch-cli/src/main.ts`. A Run
has no user, so its group and destination sends come from source `platform`
named `Hatch Agent`. Device registration is bound to a native login session,
is mobile-only and has no CLI command. Answering from the notification itself
(`POST /api/notifications/device-response`, signed with the phone's push key)
is bound to the device as well; the CLI answers the same forms with
`hatch notification respond`, and a Run answers as `Hatch Agent`. Secrets (webhook signing secrets, channel
tokens) are printed only by the create/rotate commands that mint them.

`notification update <id>` updates content and alerts phones again by default,
including when the content is unchanged or no content flags are supplied.
`--silent` maps to `UpdateNotification.silent` and only changes content; it
requires at least one content flag. SDK and Channel updates use the same
domain service and `silent: true` option. No Agent Tool is added.

## Theme and pins: CLI only, no Agent Tool

`hatch theme get | set [--accent <name>] [--dock-labels | --no-dock-labels]`
calls `ThemeService`, which reads and writes the `ui.theme` platform setting
through `src/server/theme-settings.ts`, the same service as the Appearance
settings page (accent swatches and the "Show names in the dock" switch). The accent list is
`packages/hatch-design-tokens/tokens.json`; the CLI validates `--accent`
against the copy it was built with and the platform validates again. A change
is published as the `theme.updated` platform event. Every pin change, from
the Web UI or the CLI, is published as `pins.updated`, so an open dock
refetches without a reload.

`hatch pin ...` calls `PinService`, backed by `src/server/pins.ts`, which the
Web UI Server Functions in `sidebar.ts` and `dashboards.ts`
also call. Web operation to command:

| Web UI                             | CLI                                          | RPC                |
| ---------------------------------- | -------------------------------------------- | ------------------ |
| Sidebar pins and pinned dashboards | pin list [--limit --cursor]                  | ListPins (paged)   |
| Pin an App again (sidebar)         | pin add --app                                | PinApp             |
| App page pin toggle, on            | pin add --app --if-absent                    | PinApp (if_absent) |
| Rename a pin, set its entry point  | pin update --label / --entry / --clear-entry | UpdateAppPin       |
| Remove one pin                     | pin remove --pin                             | UnpinApp (pin_id)  |
| App page pin toggle, off           | pin remove --app                             | UnpinApp (app)     |
| Drag App pins                      | pin reorder --pin                            | ReorderAppPins     |
| Pin or unpin a dashboard           | pin add / remove --dashboard                 | SetDashboardPinned |
| Drag dashboards                    | pin reorder --dashboard                      | ReorderDashboards  |

Both services accept sessions, API keys and Run JWTs alike; neither has a
device- or browser-bound operation, so there is no CLI exception. Pins record
no actor, so a Run needs no attribution. Reordering moves the listed ids to
the front and keeps the rest in their relative order; unknown or repeated ids
are rejected, for the Web UI as well.

## Dashboards: CLI only, no Agent Tool

`hatch dashboard ...` calls `DashboardService`, backed by
`src/server/dashboard-service.ts`, which the desk's Server Functions in
`src/server/dashboards.ts` also call. The layout editor saves a whole draft
at once; the CLI changes one widget at a time and commits through the same
path and lock, so both leave the same normalized layouts. Every change, from
either surface, is published as `dashboards.updated`, so an open desk
refetches without a reload. Web operation to command:

| Web UI                                         | CLI                                           | RPC                          |
| ---------------------------------------------- | --------------------------------------------- | ---------------------------- |
| Dashboard switcher, Manage dashboards          | dashboard list [--limit --cursor]             | ListDashboards (paged)       |
| The desk: widgets and their layout             | dashboard get                                 | GetDashboard                 |
| New dashboard                                  | dashboard create                              | CreateDashboard              |
| Rename, edit description, auto-refresh menu    | dashboard update                              | UpdateDashboard              |
| Delete dashboard                               | dashboard delete --yes                        | DeleteDashboard              |
| Add widget panel: widgets on offer             | dashboard widget available [--limit --cursor] | ListAvailableWidgets (paged) |
| Add widget                                     | dashboard widget add                          | AddDashboardWidget           |
| Drag, resize or size buttons, per layout width | dashboard widget layout --breakpoint …        | SetDashboardWidgetLayout     |
| Remove widget                                  | dashboard widget remove                       | RemoveDashboardWidget        |
| Pin, unpin, reorder dashboards                 | pin add / remove / reorder --dashboard        | PinService                   |

The editor snaps a drag to the nearest valid footprint; the CLI instead
rejects a size the widget does not declare and names the sizes it does.
`DashboardService` accepts sessions, API keys and Run JWTs alike and has no
device- or browser-bound operation, so there is no CLI exception.
`WorkspaceService.SetDashboardAutoRefresh` stays for the mobile client and
calls the same service.

## Providers, models and the model catalog: CLI only, no Agent Tool

`hatch provider ...`, `hatch model ...` and `hatch model catalog ...` call
`ProviderService`, `ModelService` and `CatalogService`
(`src/server/platform-api/model-rpc.ts`), which use the same
`src/server/provider-service.ts`, `src/server/provider-models.ts` and
`src/server/model-catalog/` services as the Settings → Providers page
(Server Functions in `src/server/providers.ts`). The default model is part
of `PreferenceService` (`preferences set --default-model`), like the default
model in the Agent preferences settings panel. Web operation to command:

| Web UI                                             | CLI                                                                | RPC                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Providers list                                     | provider list                                                      | ListProviders                                           |
| Provider page with its models                      | provider get / model list --provider                               | GetProvider / ListModels                                |
| Add provider gallery (presets, key link)           | provider catalog                                                   | ListCatalogProviders                                    |
| Add provider (preset or custom, key, models)       | provider add                                                       | CreateProvider                                          |
| Edit provider, replace key, enable switch, preset  | provider update                                                    | UpdateProvider                                          |
| Delete provider                                    | provider remove --yes                                              | DeleteProvider                                          |
| Test connection                                    | provider test                                                      | TestProvider                                            |
| Fetch models from the provider                     | provider fetch-models                                              | ListRemoteModels                                        |
| Add model (catalog search, metadata)               | model add, model catalog list                                      | CreateModel, ListCatalogModels                          |
| Edit model, metadata overrides, reset to catalog   | model update (--reset / --reset-all)                               | UpdateModel                                             |
| Model enable switch                                | model enable / disable                                             | UpdateModel (enabled)                                   |
| Model Category field                               | model set-kind                                                     | SetModelKind                                            |
| Delete model                                       | model remove --yes                                                 | DeleteModel                                             |
| Catalog status, check for updates, update settings | model catalog status / refresh / settings                          | GetCatalogStatus, RefreshCatalog, UpdateCatalogSettings |
| Default model and thinking level for new chats     | preferences set --default-model --thinking / --clear-default-model | UpdateAgentPreferences                                  |

API keys are write-only on every surface: the CLI reads one only from
`--api-key-file <path|->`, never from an argument value, and responses carry
`hasApiKey` instead. The services accept sessions, API keys and Run JWTs
alike and have no device- or browser-bound operation, so there is no CLI
exception. `AgentService/GetModelCatalog`, the per-chat model picker data,
stays session-only (see Known gaps). No Agent Tool is added.

`provider catalog` prints every preset without `--limit`/`--cursor`: it is a
fixed, curated list of about two dozen. `provider list`, `provider
fetch-models` and `model catalog list` page.

A provider that cannot be reached, refuses the model list or answers
something other than JSON is reported as `BAD_REQUEST` with the provider's
message (exit 2), because the fix is in the provider's settings. Changing a
provider's base URL or API type requires the API key again, so a stored key
never follows the provider to a new endpoint.

## App backend runtime: CLI only, no Agent Tool

`hatch app backend list|status|start|stop|restart` calls
`AppService/ListAppBackends`, `GetAppBackend`, `StartAppBackend`,
`StopAppBackend` and `RestartAppBackend`, which use the same
`src/server/apps/backends.ts` service as the Backends page and the App
Operations panel. Sessions, API keys and Run JWTs have the same authority, and
no operation is bound to a device or browser. The CLI covers every Web UI
action, including the force stop the UI offers for draining instances
(`stop --force`), and additionally offers `restart --force`. No Agent Tool is
added.

## App docs: CLI only, no Agent Tool

`hatch app docs list|get` calls `AppService/ListAppDocs` and `GetAppDoc`,
which use the same `src/server/apps/docs.ts` service as the Docs section of the
App manage page. Both read the docs published with the current deployment; an
archived or undeployed App fails with `CONFLICT`. The commands are read-only.
Sessions, API keys and Run JWTs have the same authority, and no operation is
bound to a device or browser. `app get` also lists the doc index under
`manifest.docs`. No Agent Tool is added.

## Device login approval: browser only

The `/cli/authorize` page approves a CLI or mobile device login for the
browser's signed-in account, so it is bound to that browser session and has no
CLI command: the CLI is the device asking to be approved. This includes
releasing the page's own claim before switching account
(`releaseDeviceClaim` in `src/server/device-claims.ts`), which acts only on the
claim the browser's account holds.

## App tasks: CLI only, no Agent Tool

`hatch app task list|run|runs|get-run|cancel|rotate-webhook-secret` calls
`AppService/ListAppTasks`, `RunAppTask`, `ListAppTaskRuns`, `GetAppTaskRun`,
`CancelAppTaskRun` and `RotateAppWebhookSecret`, which
use the same `src/server/apps/tasks/service.ts` service as the App's Tasks
pages and the Operations panel. Sessions, API keys and Run JWTs have the same
authority; a run started with a Run JWT records `agent` as its actor. No
operation is bound to a device or browser. The CLI covers every Web UI read
and action: task definitions with input schema, schedules and next run times,
webhook paths, queue and concurrency figures, run history with task and status
filters, the run inspector (steps, log, input, output, queue position), manual
runs and cancel. `run --wait` additionally waits for the result. The App's
shared webhook secret, which the Web UI shows on the task page, is printed only
by `rotate-webhook-secret`, which mints a new one (it also replaces the App
webhook's secret). No Agent Tool is added.

## Known gaps

`AgentService` (model catalog, Agent sessions) and `WorkspaceService`
(workspace navigation, Dashboard auto-refresh) still accept only a native user
session and have no `hatch` CLI commands. Pending chat messages (the queue/steer
tray: send while a run works in either mode, edit, switch between queue and
steer, cancel, Send now, resume) belong to the same gap: like sending a
message, they are only `/api/agent/sessions/<id>/pending` HTTP routes for
the Web and mobile chat, and `AgentService/GetSession` returns the tray
read-only. Both routes take an optional `clientMessageId` that makes a
resend after a lost response return the first outcome
(`src/server/agent-message-receipts.ts`); a CLI send command must expose it
too, so an Agent can retry a send safely. Both are pending: add their CLI
commands and remove the session-only gate in `src/server/platform-api/router.ts`
together, so Run credentials gain the same authority. `AuthService.CreateHandoff`
stays session-only because it exchanges the caller's native login session for
a browser session.

Account profile (nickname and avatar) is Web-only: Settings → Account edits
the nickname through Better Auth's `/update-user` and the avatar through the
`uploadMyAvatarFn` / `clearMyAvatarFn` Server Functions, and no `hatch`
command or public RPC reads or changes either. When one is added, back it
with `src/server/user-avatar-store.ts` (the avatar path lives in
`user.image`; Better Auth endpoints refuse that field) and resolve a Run
credential to the user who started the Run, as `PreferenceService` does.

The desk menu bar's "Runner offline" warning reads the same Agent Runner
status as `/settings/agent-runner`, which has no CLI command either. The
`runner_id` that the session header shows is returned by
`AgentService.GetSession`.
