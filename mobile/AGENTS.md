# Mobile UI conventions

The native app follows Desk, the visual system specified in the repository's
`DESIGN.md`: a warm ground, white sheets on a soft ink-tinted shadow, heavy
rounded type and one accent. `src/ui/theme.ts` reads every colour, radius,
font, weight and shadow from `packages/hatch-design-tokens/tokens.json`; write
no hex, `rgb()`, radius, font-family or font-weight literal anywhere else
(pills use `pill`, circles `'50%'`; the ground shapes' sizes, positions and
corner radii in `src/ui/ground.tsx` are drawing geometry, as `DESIGN.md` says). The accent is the theme's one input:
components read it with `useAccent()` (`src/ui/accent.tsx`) while rendering,
never at module scope, so the provider in `app/_layout.tsx` recolours the whole
app. Text is Nunito, code and identifiers JetBrains Mono; both are linked into
the binary by `expo-font` in `app.config.ts`, and neither has CJK glyphs (iOS
falls back to PingFang, Android to Noto Sans CJK). Use weight 700 or heavier
for names and titles that may hold CJK text, so the two faces sit level.
System controls (tab bar, navigation bar, native fields and menus) keep the
system font. A sheet on the ground floats on `shadows.card`; a group inside a
sheet is divided by hairlines; never nest a shadowed sheet in another. App
tiles go through `AppTile`, which shows the App's stored icon and falls back
to the monogram; Workflows pass `workflow`. Keep every text/surface pair at
4.5:1 or better; `theme.test.ts` guards the pairings. Respect Reduce Motion
for the egg loader.

Web surfaces are opaque white by default. Only pages that leave their
background to the app, the `/mobile/` pages, pass `transparent` to
`SecureSurface`, so the desk ground shows through; App surfaces stay opaque.

The tab bar is the system one: Home, Apps, Agent and Me by default, with
Workflows hidden. Which sections sit in it, their order and the start page
stay the user's choice (Tabs & start page); never hard-code four tabs. The
home tab keeps the `dashboard` id.

React Native owns page composition, buttons, rows, tiles, the transcript,
composer, questions and attachment previews. Use `@expo/ui` where the system
control carries real behavior: text fields, menus/pickers and their native
selection, and SF Symbols. Keep each SwiftUI/Compose subtree inside its Host,
and do not put React Native content inside native controls without the
supported bridge.

Keep Expo Router's native stack, system browser authorization, native alerts,
and Photos/Files pickers. Preserve native disabled, selected, and destructive
states. Keep touch targets at least 44 points, let text wrap/scale, and avoid
competing safe-area or keyboard insets. Use platform files for platform-specific
APIs; keep the other platform buildable without claiming unperformed acceptance.

A scrolling page's main scroll view is its first view (`ScrollScreen`, or
`PageRoot` plus `pageScrollProps`), with the masthead inside the content. Native
tabs only find a first-descendant scroll view, and UIKit then owns the tab bar,
status bar and home indicator insets; never pad for the tab bar by hand. Drive a
`RefreshControl` only from a user pull through `usePullToRefresh`, keep it
mounted, and never bind `refreshing` to query fetch state.

The app resizes while it runs: iPhone Duo moves it between a compact outer
display and a regular-width inner display that can fold, beside another app
or under a vertical bar. Size layouts from their container (`useFoldSplit`,
`Reflow`, `Columns`, `TileGrid` in `src/ui/columns.tsx`), never from the
screen, the device, orientation or a width read once. Where the display folds
is what UIKit reports as division reserved regions, read by the local
`modules/hatch-fold` view behind each container (iOS 27.1 SDK and later;
older SDKs and systems report no fold). Two columns keep their gutter on a
fold that crosses them, and without a fold layouts split evenly and start at
the leading edge. Tile grids ignore the fold: like the system home screen,
their tiles run across the whole width. Toolbars, tab bars and navigation bars move to a vertical
bar on the side; that bar, like any safe area, may sit on one edge only, so
read each edge's inset from the view that lays out (a nested
`SafeAreaProvider` or `SafeAreaView`), never the window's. Put header actions
in `Stack.Toolbar` items with both an SF Symbol and a title; custom
`headerLeft`/`headerRight` views cannot join the vertical bar. The Agent list
shows the open conversation beside itself when both fit and pushes it on a
compact width; folding or unfolding keeps that conversation open. Production
builds need the iOS 27.1 SDK or later for the full-display Duo layout.

Web surfaces decide every navigation in `src/core/surface-navigation.ts` and
leave the app only through `useExternalLink`. New windows arrive through
`onOpenWindow`; on Fabric `onShouldStartLoadWithRequest` cannot tell them apart.
Every new window opens outside the app: web pages in the system browser, any
other scheme (`mailto:`, `tel:`, `someapp://…`) in the app that owns it. Open
such links with `Linking.openURL` directly; never gate them on `canOpenURL`,
which needs every scheme declared in `LSApplicationQueriesSchemes` (iOS) or
`<queries>` (Android). Keep the sign-in handshake, credential and frame
boundaries covered by its tests.

Deep links name pages by their Hatch web paths (`hatch://app/<slug>#<route>`,
`hatch://app/<slug>/manage` for the App page, `hatch://agent/<id>`, optional
`?instance=<origin>`); phone-only pages (such as `/more/pin-app`) live
under `/more`. `src/core/deep-link.ts` owns the grammar and the path table:
a new screen gets a path there and in its tests, never a route of its own in
Expo Router's linking. `app/+native-intent.ts` hands system links to the
inbox and returns null, so Expo Router never routes them;
`useDeepLinkLifecycle` opens them once the saved sign-in is restored, and
notification taps and links followed in web surfaces go through the same
inbox. A link only navigates: it never changes data, starts a run, fills a
draft, signs in or adds an instance. It may switch to another instance this
phone is signed in to, after asking unless it is a decrypted push. Pages
without a screen open in the browser; a web surface leaves those in place.
Notification URLs (the detail's link and a verified auto-open on tap) go
through `notificationUrlAction`: Hatch pages by address or deep link open in
the app, and a `hatch:` link never leaves for the system. Any other scheme is
allowed to leave: web pages open in the browser and other schemes (`mailto:`,
`someapp://…`) in the app that owns them; document schemes (`javascript:`,
`data:`, …) open nothing.

An App screen's back steps through WebKit's own `canGoBack` before leaving.
While the page has history the screen turns off its native swipe
(`gestureEnabled`), WKWebView's swipe takes over, and `useWebHistoryBack` turns
the back button and Android back into one page step; other removals pass. The
sign-in pages are replaced, never pushed, so they never become history.

Authentication, query identity, cancellation, draft ownership, and duplicate
submission guards are independent of presentation. Native text bindings must
not echo delayed JavaScript edits over newer text or reset selection. Submission
must read current native field snapshots. Preserve the compact composer's
scrolling height bound and the separate accessible attachment/send action row.

Install dependencies with `pnpm exec expo install` from mobile. Adding or changing
native modules requires prebuild, native compilation, and installation; Metro
reload is insufficient. Verify real iOS Simulator interactions with screenshots
and recordings, including keyboard, small screens, safe areas, device appearance,
Dynamic Type, and affected login/chat/attachment flows. State the exact runtime;
web previews and Metro exports are not native runtime acceptance. Do not describe
a Simulator as a physical device.
