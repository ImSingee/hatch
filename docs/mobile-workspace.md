# Mobile workspace integration

Use the public Connect endpoint at `/api/rpc` with a Better Auth session Bearer
credential. `WorkspaceService.GetWorkspace({})` also accepts a same-origin browser
session cookie. API keys and Run credentials cannot read this interactive view;
explicit invalid credentials never fall back to a cookie.

The response contains:

- `dashboards`: all Dashboard summaries, including unpinned entries, ordered by
  `sortOrder` then `createdAt`, both ascending. Each has `id`, `name`,
  `description`, `pinned`, and `autoRefreshSeconds` (zero disables refresh).
- `appPins`: ordered by `sortOrder` then `createdAt`, both ascending. Preserve the
  array and key entries by pin `id`, not `appId`: the same App may have several
  labels and destinations. Each entry carries `appId`, `appSlug`, `label`, and
  `entryHash`. The hash has no leading `#`; an empty value opens the App root.
  Use the slug for `/app/:appSlug` and retain the entry hash when navigating.
- `pinnedWorkflowIds`: non-archived pinned Workflows, ordered by `updatedAt`
  descending, matching the current web sidebar.

Archived Apps and Workflows are excluded. Dashboard and App-pin projections share
read functions with the web UI. On an empty instance, both web and native reuse
the existing idempotent `default` / `My Dashboard` initialization. Rejected
requests do not initialize it. This is a single-tenant shared workspace, not
per-user resource ownership.

## Native app structure

The native app (`mobile/`) follows Desk, the visual system in `DESIGN.md`, and
reads every colour, radius, font, weight and shadow from
`packages/hatch-design-tokens/tokens.json`. It uses the workspace like this:

| Screen                 | Data                                                              | Shows                                                                                                      |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Home (`dashboard` tab) | `GetWorkspace`, `ListApps`, `ListWorkflows`, the dashboard canvas | One dashboard's widgets in a sheet, page dots to switch dashboard, then the pinned Apps and Workflows grid |
| Widgets                | the dashboard canvas                                              | The same dashboard at full height; opened from Home with "All widgets"                                     |
| Apps                   | `ListApps`, `ListWorkflows`, `GetWorkspace`                       | Every App, then every Workflow, searchable, by name or by latest change; pinned rows carry a pin           |
| Workflows              | `ListWorkflows`, `GetWorkspace`                                   | Workflows alone; hidden from the tab bar by default                                                        |
| App page               | `GetApp`, `GetWorkspace`                                          | Icon, name, status, Open, and a link to the web management page                                            |
| App                    | the App's `/app/:slug/embed/` page                                | The App itself, in an authenticated WebView                                                                |
| Agent                  | the `AgentService` session RPCs                                   | Conversations; beside the open one when the width allows                                                   |
| Me (`more` tab)        | local preferences                                                 | Every section, notifications, Tabs & start page, the instance                                              |

The tab bar is the system one. By default it holds Home, Apps, Agent and Me;
which sections sit in it, their order and the start page are the user's choice
and are stored on the phone. Tab ids did not change with the redesign (`dashboard`
is Home, `more` is Me), so saved orders and `hatch://` links keep working.

Home pages by dashboard, not by widget: widgets are web content rendered by the
dashboard canvas, one WebView per dashboard. The pinned grid uses `appPins` as
described above: one tile per pin, keyed by pin `id`, opening the App at the
pin's `entryHash`. A tile on Home opens the App directly; a row in Apps opens
the App page first.

With room for two columns (an unfolded iPhone Duo, landscape), Home puts the
widgets in the leading column and the pins in the trailing one, and Agent shows
the list beside the conversation. Columns split on the fold when there is one.

### App icons

`ListApps` and `GetApp` return `iconPath` for an App with a stored icon. Append
`&size=64`, `128` or `256` and request it from the instance with the session in
an `Authorization: Bearer` header; never put the credential in the address. An
App without `iconPath`, a Workflow, or an icon that fails to load shows the
monogram: the first character of the name on a `tiles` colour chosen by the
same hash of the id as the web `AppGlyph`, so an App has one tint everywhere.
Icons are kept in memory only.

### Pins

The pinned grid reads `PinService.ListPins` and changes pins with `PinApp`
(`ifAbsent`), `UnpinApp` (by pin id) and `SetWorkflowPinned`. An "Add" tile
after each grid opens a picker of what is not pinned yet; touching and holding
a tile offers to unpin it. Pins are shared by every client, so a change
re-reads the pins and the lists that mark pinned rows. Reordering pins is not
offered on the phone yet (`ReorderAppPins` exists).

### Accent and ground

The accent is the theme's single input. The app reads the instance's
`ui.theme` accent through `ThemeService.GetTheme` after sign-in and again each
time it returns to the foreground, and keeps the last value per instance on the
phone so a cold start draws it from the first frame. An accent name the build's
tokens do not define falls back to the default. The app does not consume the
platform event stream, so a change made elsewhere shows on the next foreground.

Every page draws the Desk ground shapes (`DESIGN.md`, "Ground shapes") from the
`ground` tokens; the circle follows the accent.

## Browser session and dashboard canvas

The merged authentication contract is resource-independent:

1. Call `AuthService.CreateHandoff({})` with the existing user session.
2. In a fresh browser/WebView, POST a form containing only `ticket` to the
   response `url`. Never put the ticket or session token in a URL.
3. Wait for the response's exact `completionUrl` to load successfully. This
   establishes the original session as an HttpOnly cookie.
4. Navigate within that same browser to `/mobile/dashboard/:dashboardId`, using
   an encoded ID from `GetWorkspace`. Ordinary web navigation continues to use
   `/dashboard/:dashboardId`.

The mobile route is outside the web navigation shell. It uses the existing
Dashboard widget runtime, disables layout editing, supports manual and configured
automatic widget refresh, and includes loading, retry and empty states. The route
checks the session and the underlying server functions independently enforce
session authentication. Missing Dashboard IDs show a retryable error.

Do not call `WorkspaceService.CreateDashboardHandoff`; this service has no such
method. Mobile clients from the earlier branch must replace that call with the
four-step generic handoff sequence above. No new handoff target or arbitrary URL
parameter is introduced. Session revocation, ticket replay and origin checks
remain owned by the shared AuthService implementation.

## Dashboard refresh settings

`WorkspaceService.SetDashboardAutoRefresh({ id, seconds })` saves the same
Dashboard preference used by the web UI and returns `{ seconds }`. It requires a
valid user session, rejects missing Dashboard IDs, and accepts whole seconds from
0 to 3600. Zero disables automatic refresh. API keys, Run credentials and hostile
origins are rejected before any write.

The shared `REFRESH_PRESETS` exported by `@hatch/platform-api` supplies both web
and native controls: Off, 5s, 10s, 30s, 1m, 5m, 15m, 30m and 1h. Unlike local tab
preferences, this setting belongs to the Dashboard and is shared across clients.
The web setter and public RPC use the same persistence function.

For the mobile canvas, the native host owns manual refresh controls and timer
lifetime. The canvas has no automatic timer or platform refresh buttons. Native
refresh commands address the currently displayed Dashboard and use the existing
widget refresh protocol; they do not reload authentication or transmit credentials.

In native-host mode, each widget's Open app action is a document link. The native
WebView intercepts its load request and opens the App in the native stack without
moving the canvas router or history. Ordinary web Dashboard navigation is unchanged.

Deploy this Platform change together with a native client that owns refresh controls
and scheduling. Older native clients that depend on the canvas's web refresh button
or timer lose those controls until updated. There are no database migrations,
environment changes, or App/Workflow compatibility version changes.
