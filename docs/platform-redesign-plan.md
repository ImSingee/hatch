# Platform redesign plan ("Desk")

Status: proposal. Precedes [native-app-ui-plan.md](native-app-ui-plan.md): the
platform's own UI is redesigned first, on the current stack; Apps keep their
React web frontend. Statements are marked **[fact]** (checked in the code or the
design canvas), **[decision]**, or **[assumption]** (to validate).

Design source: the "Hatch · Desk 个人桌面" canvas (48 artboards on five pages:
Web, Desktop macOS/Windows, iOS, Android, iPhone Duo).

## 1. Goals, scope, completion criteria

Goals:

1. Web, mobile and a new macOS desktop app share one visual system taken from
   the canvas: desk background, menu bar, dock, windows, widgets.
2. One token file is the source for every platform, in the shape the App theme
   will use later.
3. An App runs inside a Desk window through one component, `AppSurface`, so
   the later NSH change replaces what is inside an App window and nothing
   around it.
4. The accent colour is a stored setting, changeable from the UI and the CLI.

In scope: every existing platform page on web and mobile; a macOS desktop app
with one main window.

Out of scope **[decision, confirmed by the user where noted]**:

- Dark mode (user). Tokens keep a `dark` slot that stays empty.
- Changing how App icons are made or stored. Apps already have icons: an
  image model setting, Agent-generated or uploaded icon images, and the
  `hatch` icon commands. The redesign only restyles how the tile is displayed:
  the icon image takes the Desk tile's size and radius, and an App without an
  icon keeps the monogram tile, tinted from the new palette. Per-App colours
  stay out of scope (user).
- Home-screen widgets on iOS/Android, the macOS menu-bar popover, the Windows
  app and its taskbar panel. Home-screen widgets cannot render the current
  HTML widgets and wait for native widgets.
- Several Apps running at the same time on the web (user): keeping Apps
  alive in the background, a limit and eviction, side-by-side App windows and
  an "update available" notice for background Apps. This moves to the NSH work
  in [native-app-ui-plan.md](native-app-ui-plan.md). One App is open at a
  time, as today; the shell must still not assume that a page can only ever
  hold one App (section 3.3).
- Serving Apps from a separate origin.
- The brand mark (waiting on the user). The artboards draw an egg-shaped
  mark; the web keeps the current logo until the user decides whether to
  change the brand.
- Changing App frontends, the App SDK or the Agent.
- Translating the UI. The canvas is drawn in Chinese; product copy stays
  English, as today.

Done when:

- Each web artboard matches the running page at 1440, 2560, 1024, 768 and 560
  wide, checked by screenshot.
- An App opens inside the Desk window through `AppSurface`; reload, open in
  a new tab and Manage work from its title bar.
- `hatch theme set --accent teal` changes web, mobile and desktop without a
  rebuild.
- The mobile app has no colour or radius literal outside the token file.
- The macOS app signs in, shows the sidebar layout and opens Apps in the same
  window model.
- Every existing route still exists and passes its durable tests.

## 2. Current behavior and preparation

- Web **[fact]**: Mantine v8, light forced in `src/routes/__root.tsx`. Themes
  live in `src/ui/` (`ember` active, plus `zinc`, `aurora`, `blue`, `orange`);
  167 files import Mantine, 24 CSS modules, 3 hard-coded hex colours. The shell
  is a Mantine `AppShell` with a 272 px sidebar and 56 px header
  (`src/routes/_app.tsx`, `src/components/app-shell/`).
- Visual gap **[fact]**: today ember orange, Geist + Fraunces, white body, flat
  bordered cards, radius 12. The canvas uses ground `#EDEBE6`, ink `#1E2230`,
  accent `#3F51C7` with three alternatives (`#0F766E`, `#B4472A`, `#7A3FB8`),
  Nunito + Noto Sans SC + JetBrains Mono, white translucent surfaces with
  shadow, radii up to 26.
- Pins **[fact]**: the dock's data exists. `sidebar_items` holds App pins
  (label, icon, entry hash, order); `workflows.pinned` and `dashboards.pinned`
  with `sortOrder`. The CLI has no command to list, add, remove or reorder
  pins, and none to edit a dashboard's widgets.
- App icons **[fact]**: `src/components/apps/app-glyph.tsx` is a custom
  tile, not a Mantine component. It shows the App's stored icon image when
  there is one and otherwise a monogram (first letter, tint hashed from the
  App id). Workflows share the tile and have no icons.
- App page **[fact]**: `src/routes/_app/app/$appSlug/index.tsx` mounts one
  same-origin iframe keyed by its URL; leaving the route destroys it.
- Dashboards **[fact]**: layouts are stored per `desktop`, `tablet` and
  `mobile` breakpoint. `/mobile/dashboard/$dashboardId` is a chrome-less page
  the native client embeds.
- Mobile **[fact]**: Expo 58, `expo-router` native tabs, `@expo/ui`. Its own
  "Field Guide" palette in `mobile/src/ui/theme.ts`, independent of the web by
  design. Fold support exists (`fold-probe`, `fold-split`). Tabs are
  user-orderable (`navigation-preferences`).
- Desktop **[fact]**: none.
- Several Apps in one page **[fact]**: three iframes, one App each, ran side by
  side in the spike with independent state. This plan does not build on it
  (see out of scope); it is why the shell is designed not to rule it out.

Assumptions to validate before the dependent step:

- **B1** A native NSH view can be added to a Tauri 2 window on macOS. Decides
  the desktop host (section 3.5).
- **B2** Passkey sign-in works in the desktop webview for a self-hosted
  origin. If not, the desktop app signs in through the system browser with the
  existing device-login flow.
- **B3** Nunito renders Latin text acceptably next to the system CJK font on
  iOS and Android without bundling Noto Sans SC.

## 3. Implementation approach

### 3.1 Tokens

**[decision]** `packages/hatch-design-tokens/tokens.json` is the only place a
colour, radius, font, weight, shadow or motion value is written. Its shape
(values abridged):

```json
{
  "name": "desk",
  "fonts": { "sans": "Nunito", "mono": "JetBrains Mono" },
  "fontWeights": { "body": 500, "strong": 600, "label": 700, "heading": 800 },
  "radius": {
    "xs": 6,
    "sm": 9,
    "md": 12,
    "lg": 16,
    "tile": 18,
    "xl": 20,
    "window": 24,
    "widget": 26,
    "dock": 28
  },
  "sizes": { "widgetIcon": 26, "dockTile": 40, "deskTile": 60 },
  "accents": {
    "indigo": "#3F51C7",
    "teal": "#0F766E",
    "clay": "#B4472A",
    "violet": "#7A3FB8"
  },
  "defaultAccent": "indigo",
  "neutral": ["#FAF9F6", "…eight more…", "#1E2230"],
  "hues": { "red": "#B91C1C", "amber": "#B45309", "green": "#15803D" },
  "tiles": ["#C2410C", "#7C3AED", "…"],
  "light": {
    "background": "#EDEBE6",
    "foreground": "#1E2230",
    "card": "#FFFFFF",
    "muted": "#F6F5F1",
    "muted-foreground": "#4F5666",
    "border": "#ECEAE4",
    "input": "#D5D1C8",
    "ring": "#1E2230"
  },
  "dark": null,
  "surfaces": {
    "panel": "…",
    "dock": "…",
    "widget": "…",
    "window": "#FAF9F6",
    "bubble": "#F3F2EE",
    "composerBorder": "#DEDBD3",
    "sunken": "…",
    "hairline": "…"
  },
  "ground": { "accentTint": 18, "warm": "#F1DFD3", "fresh": "#DCEADF" },
  "shadows": { "card": "…", "dock": "…", "window": "…" },
  "motion": { "easing": "…", "fast": 120, "base": 180 }
}
```

`light` uses the shadcn `cssVars` names, which is what NSH `theme.json` reads,
so the App theme later is this file plus the chosen accent. `accents`, `hues`
and `tiles` store one colour each; the ten-shade ramps Mantine needs are
derived at run time by `colorRamp()` in `src/ui/theme/theme.ts`. `neutral` is
written out because it is not a mix of one colour. `surfaces` holds what the
shadcn names cannot express: translucent chrome, and the alpha hairline and
hover wash that must read on both the ground and a white sheet.

**[decision]** There is no code generation. `src/ui/theme/theme.ts` and
`src/ui/theme/cssVariableResolver.ts` import `tokens.json` directly and turn it
into the Mantine theme and into CSS variables at start-up; CSS files use those
variables and contain no literal values. A generator and a staleness check
would add a build step and a second copy of every value for no gain while the
only consumer is TypeScript that can import JSON. The package is a plain
directory, not a workspace package. Fonts are self-hosted through
`@fontsource-variable/nunito` and `@fontsource-variable/jetbrains-mono`; no
CJK font is bundled. Step 5 decides how the mobile app reads the same file
(a direct JSON import is expected to work there too).

The four old web themes are deleted, not kept beside the new one; the mobile
palette goes in step 5. `DESIGN.md` is rewritten around the tokens and gains a
component specification (button, field, card, list row, window, dock tile,
empty state: sizes, states, radii). That specification is what `@hatch/ui`
implements later; platform React components are not reused by NSH Apps.

### 3.2 Accent setting

**[decision]** One instance-wide setting, `platformConfig` key `ui.theme`:
`{ accent: 'indigo' | 'teal' | 'clay' | 'violet' }`, default `indigo`. Read at
start-up by every client and pushed over the existing platform event stream
when it changes. The later App theme extends this key instead of adding a
second one; `native-app-ui-plan.md` section 3.7 is updated to say so.

### 3.3 Web shell

Replaces `AppShell` in `src/routes/_app.tsx` with three parts under
`src/components/desk/`:

- **Menu bar**: brand menu, primary navigation (Desk, Agent, All apps), a
  runner warning, search (`⌘K`), date, account menu.
- **Dock**: pinned Apps and Workflows from the existing pins, a marker under
  the open App, and an add button that opens the pin picker.
- **Window**: the frame every page except the desk renders inside (title bar,
  minimise, close, optional section list on the left). Routes stay as they
  are; the window is a layout component, so deep links and the back button
  keep working.

Widths follow the canvas: at 768 the window fills the stage; at 560 the menu
bar collapses and the dock becomes the four-item tab bar; 2560 widens the desk
grid.

**[decision]** (user review) The menu bar has no space name: the product has
no space concept to name. The artboards' space label is dropped.

**[decision]** (user review) The runner chip is a warning: it appears, red,
only while no Agent Runner is connected ("Runner offline") and links to the
Agent Runner status page. Nothing shows while a runner is online. Below 768
only its red dot stays.

**[decision]** The App detail panel in All apps has two pin actions. "Pin to
dock" / "Remove from dock" is the App pin (`PinService`). "Pin to desk" puts
the App's widget on the current dashboard through the same domain call as
`hatch dashboard widget add`: default size, below the other widgets, and
published as `dashboards.updated` so an open desk updates. The current
dashboard is the one this browser showed last, else the first. An App with
several widgets offers a choice. The button is disabled, with the reason
under it, when the App has no widget or its widgets are all on that
dashboard already.

**[decision]** Search (`⌘K` / `Ctrl+K`, or the menu bar button) is a command
palette over the shell's places, every App and every Workflow, built on
`@mantine/spotlight`. It searches what the client already has; there is no
search RPC. The shortcut also works from text fields. While focus is inside
an App or widget frame, the key press goes to that frame, not to the shell.

**[decision]** `AppSurface` is the only component that knows how an App is
rendered, and it hosts exactly one running App inside a Desk window. Today it
mounts the iframe that `/app/$appSlug` mounts now; later it mounts an NSH
player. The shell talks to it through a fixed interface (`load`, `visible`,
`route`, `title`, `reload`, `close`). That public contract is iframe-free:
nothing outside the component sees a frame, a window or a document.

**[decision]** Inside the component, route and title are read from the
same-origin frame directly for now. A `postMessage` bridge needs a script
injected by the App runtime (`serve-app.ts` or the App SDK), which changes
the deployed-App contract; it is deferred to the NSH work in
[native-app-ui-plan.md](native-app-ui-plan.md), where the player brings its
own channel. Until then the direct read stays inside `AppSurface` and nowhere
else.

- An App window has the standard title bar plus reload, open in a new tab and
  Manage.
- One App is open at a time. Leaving `/app/$appSlug` unmounts it, as today;
  nothing keeps an App running in the background.
- Nothing in the shell assumes there is only one surface: the dock marker,
  the window frame and the route take the App they refer to as input and hold
  no "the current App" global, so the NSH work can mount several surfaces
  without changing them.

### 3.4 Pages

Every route moves into the new shell. Pages the canvas does not draw follow
the nearest drawn pattern **[decision]**:

| Page                                   | Pattern                                               |
| -------------------------------------- | ----------------------------------------------------- |
| Notifications list and detail          | Session window: list on the left, detail on the right |
| Notification settings, Backends, About | Sections of the Settings window                       |
| Several dashboards                     | Menu on the desk title; "Edit layout" manages them    |
| Global executions, workflow executions | Table inside the Workflows window                     |
| One execution                          | Workflow detail window with a step timeline           |
| CLI authorize, 404                     | Login card on the desk background                     |

### 3.5 Mobile and desktop

Mobile: screens are rebuilt on the tokens with the canvas structure
(home with widget pager and pinned grid; Apps; Agent; Me). iOS and Android
keep system controls and system fonts as drawn. User-orderable tabs stay. The
Duo layouts use the existing fold support. `/mobile/dashboard/…` takes the new
tokens.

Desktop **[decision, depends on B1]**: a Tauri 2 app in `desktop/`, macOS
only. First run asks for the instance URL, as the mobile app does. The main
window loads the platform web UI, which renders the sidebar layout from the
macOS artboards when the host announces itself. Native parts: window chrome,
the application menu, `⌘K` / `⌘N` / `⌘,`, and deep links. Apps run through the
same `AppSurface`. If B1 fails the host is a small AppKit program with a
`WKWebView` instead, so that NSH views can be added later.

## 4. Database changes

None. Pins and dashboards use existing tables; the accent uses
`platformConfig`.

## 5. Platform API, CLI, Platform/Runner protocol

New RPCs, each calling the same domain service as the Web UI:

- `ThemeService.GetTheme`, `SetTheme`. `GetTheme` also returns the accents
  that can be chosen, so there is no separate list call.
- `PinService.ListPins`, `PinApp`, `UpdateAppPin`, `UnpinApp`,
  `ReorderAppPins`, `ReorderDashboards`, `SetWorkflowPinned`,
  `SetDashboardPinned`. A service of its own because `WorkspaceService` is
  still limited to user sessions.
- `WorkspaceService.ListDashboards`, `GetDashboard`, `AddWidget`,
  `RemoveWidget`, `SetWidgetLayout`.

CLI: `hatch theme get | set --accent <name>`;
`hatch pin list | add | update | remove | reorder`;
`hatch dashboard list | get | widget add | widget remove | widget layout`.

`ListPins` and `ListDashboards` take an optional `cursor` and `limit`
(1–100) and return `next_cursor` while more entries follow; without a limit
they return every entry, so existing clients are unchanged. `ListPins` pages
one sequence: App pins, then Workflows, then dashboards. The cursor is an
offset, because these lists are short and ordered by the user.
`hatch pin list` and `hatch dashboard list` take `--limit` and `--cursor`.
`AgentService.GetSession` gains an optional `runner_id`, the runner whose
workspace holds the chat; the session header shows it.

The pin and dashboard commands close a gap that exists today; the redesign
changes both surfaces, so they ship with it. There is no CLI exception: the
redesign adds no capability bound to a device or browser. `PROTOCOL_VERSION`
is unchanged.

## 6. App/Workflow package contracts and compatibility

Unchanged. No compatibility constant moves. Apps are not told about the theme
in this plan.

## 7. Historical platform data migration

None.

## 8. Existing App/Workflow migration

None. Existing Apps open in the new window unchanged.

## 9. Security and permissions

- An App iframe is same-origin with the shell and can reach it. This is
  today's trust model, unchanged; a separate origin stays a follow-up, and
  `AppSurface` keeping every access to the frame inside one component keeps
  that change local.
- The desktop app keeps the session in the webview's cookie store, loads only
  the configured instance origin, and opens other links in the system browser.
- Theme and pin RPCs accept every valid credential, as required for public
  RPCs.

## 10. Tests and acceptance

- Durable: `AppSurface` loads an App, reloads it and reports its title and
  route through the fixed interface; CLI argument mapping and input rejection
  for the new commands.
- Acceptance: the completion criteria in section 1, by screenshot against the
  artboards at the five widths; iOS simulator and Android emulator runs;
  macOS app run; each new CLI command against a local instance.
- `pnpm check:types`, `pnpm format`, `pnpm lint`, `pnpm platform-api:check`.

## 11. Order and recovery

**[decision, user]** The redesign ships as three pull requests. The steps
below are ordered work items, not pull requests.

| PR  | Base            | Steps | Content                                                  |
| --- | --------------- | ----- | -------------------------------------------------------- |
| 1   | `master`        | 1–4   | Design and web: tokens, accent setting, web shell, pages |
| 2   | the PR 1 branch | 5     | Mobile                                                   |
| 3   | the PR 1 branch | 6     | The macOS desktop app                                    |

Tokens alone cannot be accepted visually, so PR 1 is accepted on the complete
web UI. PR 2 and PR 3 are independent of each other.

1. Tokens, the Mantine theme built from them, fonts, `DESIGN.md`. Every page
   changes colour and type at once; layout is untouched.
2. Accent setting: `ui.theme`, `ThemeService`, `hatch theme`.
3. Web shell: menu bar, dock, window frame, `AppSurface`, the five widths,
   and the pin RPCs with `hatch pin`.
4. Pages, in order: desk and dashboard editing (with the dashboard RPCs and
   `hatch dashboard`), Agent, All apps and App manage, Workflows, Settings,
   Notifications, Login and the remaining pages.
5. Mobile: tokens first, then screens.
6. Validate B1 and B2, then the macOS app.

Branches:

- `claude/desk-tokens-theme-ea9322` is the integration branch of PR 1. Steps
  2 to 4 are built on branches cut from it and merged back into it. It is
  rebased onto `master` regularly, so conflicts are resolved while they are
  small. PR 1 is opened when steps 1 to 4 are done and the web completion
  criteria in section 1 hold.
- The mobile and desktop branches are cut from the integration branch and
  rebased whenever it moves. Each is opened as a pull request against the
  integration branch and retargeted to `master` once PR 1 merges.

Nothing is irreversible: there is no schema or data change. Before a merge, a
step is undone by reverting its merge on the integration branch; after, by
reverting the pull request. PR 2 and PR 3 revert on their own; reverting PR 1
requires reverting whichever of them has merged first.

## 12. Documentation, skills, prompts, templates

- `DESIGN.md` rewritten; `src/ui/theme/README.md` updated.
- `docs/cli-tool-parity.md` and `packages/hatch-cli/README.md` gain the new
  commands.
- `docs/mobile-workspace.md` updated; a new `docs/desktop.md`.
- `docs/native-app-ui-plan.md`: theme storage, `AppSurface` and the desktop
  host now come from this plan; several Apps running at once on the web stays
  in that plan.
- `README.md` changes, if any, are proposed separately for approval.
- No change to `skills/`, the system prompt or the App templates.
