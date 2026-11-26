# Design

"Desk" is the visual system of Hatch: a warm cream desk, white sheets that
float on it, rounded heavy type, and one accent colour. This file describes the
tokens and specifies the components built from them. It is written so that a
second implementation (the planned `@hatch/ui` App component library) can be
built from it without reading the platform's React code.

The values below are those of `desk`, the default theme. A theme is data:
the instance draws one active theme from its library (see [Themes](#themes)),
and every client draws the resolved tokens at run time.

## Where values live

| What                                   | Where                                                  |
| -------------------------------------- | ------------------------------------------------------ |
| `desk` values, weights, sizes, motion  | `packages/hatch-design-tokens/tokens.json`             |
| Theme documents, presets, derivation   | `packages/hatch-design-tokens/src/`                    |
| Mantine theme built from a theme       | `src/ui/theme/theme.ts`                                |
| CSS variables and Mantine colour roles | `src/ui/theme/cssVariableResolver.ts`                  |
| Surface treatment of Mantine parts     | `src/ui/theme/desk.css`                                |
| Font files                             | `@fontsource-variable/*`, imported in `src/styles.css` |

`tokens.json` is imported as JSON; there is no generation step. Clients draw
the theme the platform resolves (`ThemeService.GetTheme`), never the token
file directly; they keep built-in `desk` for the first frame. Do not write a
hex, `rgb()`, radius, shadow or font-family literal in `src/**/*.css` or in
component code. Use a Mantine variable (`--mantine-color-*`,
`--mantine-radius-*`) or one of the Desk variables listed below. The only
literals kept are mask stops (`#000` in a `mask-image` is an alpha value, not a
colour) and geometry that is not part of the palette (`999px` pills, `50%`
circles).

## Colour

### Roles

`light` uses the shadcn `cssVars` names so the same file can feed an App theme
later.

| Role            | Token                       | Value        | Use                                                        |
| --------------- | --------------------------- | ------------ | ---------------------------------------------------------- |
| Ground          | `light.background`          | `#EDEBE6`    | The desk: page background                                  |
| Ink             | `light.foreground`          | `#1E2230`    | Text, icons, focus ring                                    |
| Muted ink       | `light.muted-foreground`    | `#4F5666`    | Secondary text, placeholders, table headers                |
| Sheet           | `light.card`, `popover`     | `#FFFFFF`    | Cards, windows, menus, fields                              |
| Muted sheet     | `light.muted`, `secondary`  | `#F6F5F1`    | Window title bars, read-only wells, code blocks in a card  |
| Sunken          | `surfaces.sunken`           | `#E4E2DC`    | Segmented-control track                                    |
| Panel           | `surfaces.panel`            | white 72%    | Translucent chrome over the ground: the menu bar           |
| Dock panel      | `surfaces.dock`             | white 82%    | The dock and the tab bar, which sit over the ground shapes |
| Widget panel    | `surfaces.widget`           | white 80%    | Desk widget panels and the desk's own panels on the ground |
| Window body     | `surfaces.window`           | `#FAF9F6`    | The pale body of a window that grouped cards sit on        |
| Bubble          | `surfaces.bubble`           | `#F3F2EE`    | The Agent's chat bubble                                    |
| Composer border | `surfaces.composerBorder`   | `#DEDBD3`    | The 1.5 px outline of the Agent composer                   |
| Hairline        | `surfaces.hairline`         | ink 14%      | Dividers and outlines; reads on ground and sheet           |
| Field border    | `light.input`               | `#D5D1C8`    | Border of a field                                          |
| Hover / pressed | `surfaces.hover`, `pressed` | ink 6% / 10% | Hover wash, neutral tint, skeletons                        |
| Scrim           | `surfaces.scrim`            | ink 45%      | Behind modals; over thumbnails                             |
| Destructive     | `light.destructive`         | `#B91C1C`    | Same value as `hues.red`                                   |

### Ground shapes

The desk is not a bare colour. Three large shapes lie on the ground behind
everything, cut off by the edges of the page: a circle at the top right, a
rounded slab at the bottom left, and a smaller rounded square in the middle,
the last two slightly rotated. Each is one flat fill close to the ground in
lightness:

| Shape  | Token               | Value                                                     |
| ------ | ------------------- | --------------------------------------------------------- |
| Accent | `ground.accentTint` | 18% of the current accent on white (`#DCE3F1` for indigo) |
| Warm   | `ground.warm`       | `#F1DFD3`                                                 |
| Fresh  | `ground.fresh`      | `#DCEADF`                                                 |

They carry no content, never sit inside a sheet, and have no gradient, blur,
glow, shadow, border or motion. Their sizes, positions and corner radii are
geometry of the drawing, not palette, and are written in the shell's CSS.
Text is never placed directly on a shape without a sheet or panel under it.

`light.border` (`#ECEAE4`) is kept for the App theme, where borders sit on
white. The platform uses the hairline instead because `#ECEAE4` disappears on
the ground.

### Accent

One accent at a time, default `indigo` `#3F51C7`; alternatives `teal`
`#0F766E`, `clay` `#B4472A`, `violet` `#7A3FB8`. The accent is a quick pick that
replaces the active theme's `primary`; with no accent chosen, the theme
shows its own `primary`. A fresh instance and a reset have no
accent (`desk`'s own primary is `indigo`, so it looks the same), and the
settings page and `hatch theme set` say when a chosen accent hides a custom
theme's own primary. The accent is used
for the primary action of a view, the current navigation item, selection and
links. It is not used for decoration.

### Ramps

Mantine needs ten shades per colour. Tokens store one value per colour and
`colorRamp()` derives the rest, ordered from the surface to the ink: the token
is shade 6; on a light theme shades 0–5 mix it with white (92, 86, 72, 50, 30,
14 %) and shades 7–9 with black (16, 32, 48 %). On a dark theme shades 0–5 mix
it with the card (85, 75, 60, 42, 25, 12 %) and shades 7–9 with white (40, 60,
75 %), so text shades stay readable on the dark surfaces. A filled control's
hover and pressed shade is one step from the fill, away from its label
(`pressedShade`): under white text that is shade 7 on light and shade 5 on
dark; a pale fill with dark text steps lighter.

| Variant      | Fill                 | Text                    |
| ------------ | -------------------- | ----------------------- |
| filled       | shade 6              | white                   |
| filled hover | away from the label  | white                   |
| light (tint) | shade 1, hover 2     | shade 8                 |
| outline      | transparent, hover 0 | shade 7, border shade 7 |
| text, link   | —                    | shade 7                 |

Every pairing in this table is at least 4.5:1 for all accents and hues.

`neutral` backs Mantine's `gray` (and `dark` on a light theme). `desk` writes
it out in full (ten steps from `#FAF9F6` to ink); other themes derive it from
`secondary` (1), `border` (2), `muted-foreground` (6) and `foreground` (9). Its tint variant is the hover wash with shade-7
text, so a neutral badge reads on the ground and on a sheet.

### Hues and status

`hues` holds the eight chromatic colours: red, orange, amber, green, teal,
blue, violet, pink. Mantine names map onto them (`yellow` → amber, `grape` →
violet). Status meaning: red = error or destructive, amber = warning, green =
success, blue = information. Colour never carries state alone; pair it with an
icon or a word.

`tiles` holds eleven saturated fills for monogram tiles. All carry white text
at 4.5:1 or better, also under `tileLight`, the top-lit overlay (white 12% to
black 18%) painted over them.

### Themes

A theme document holds a small set of semantic values; `resolveTheme`
(`packages/hatch-design-tokens/src/theme.ts`) derives every other token from
it. There is no per-token editor: the translucent surfaces, dividers, washes,
shadows and ground tints are tuned against the base colours, and editing them
one by one gives unreadable combinations.

```json
{
  "name": "Meadow",
  "appearance": "light",
  "colors": {
    "background": "#F3F6EF",
    "foreground": "#1C2A1F",
    "card": "#FFFFFF",
    "primary": "#2F6B3A",
    "secondary": "#E8EFE3",
    "muted": "#E8EFE3",
    "muted-foreground": "#4B5B4E",
    "border": "#D9E3D3",
    "destructive": "#B91C1C"
  },
  "radius": 6,
  "fonts": { "sans": "Nunito", "mono": "JetBrains Mono" }
}
```

- `appearance` and all nine `colors` are required; colours are opaque
  (`#RRGGBB`, `#RGB`, `rgb(r g b)`). `radius` (px, 0–32, default 12) scales
  every radius; `fonts` name a bundled face or `system` (default Nunito and
  JetBrains Mono).
- Derived: `card-foreground`, `popover`, `secondary-foreground` and `ring` are
  `foreground`; `primary-foreground` and `destructive-foreground` are white,
  or the theme's dark ink when white reads worse; `input` is `border` 12 %
  towards `foreground`; `hairline`, `surface-hover`, `surface-pressed` are
  `foreground` at 14, 6, 10 %; panel, dock and widget surfaces are `card` at
  72, 82, 80 %; the ground shapes tint `card` with the accent (18 %), orange
  (18 %) and green (16 %); shadows use `foreground` (light) or `background`
  (dark) as ink. `glass-edge`, the 1 px edge of translucent panels, is `card`
  on light and `foreground` at 8 % on dark.
- Presets: `desk` (light, the default; it pins the hand-tuned values its
  derivation only approximates: the neutral ramp, `input`, window, bubble,
  sunken and composer surfaces, and the warm and fresh ground shapes) and
  `desk-dark` (dark, fully derived from `tokens.json` `dark`).
- Saving a theme rejects unknown keys, unparsable colours, fonts that are not
  bundled, and text below 4.5:1 on its surface: `foreground` on `background`,
  `card`, `secondary` and `muted`; `muted-foreground` on `background`, `card`
  and `muted`; `primary-foreground` on `primary`; `destructive-foreground` on
  `destructive`; `destructive-text` (error text: the destructive colour, or
  the first of its shades 7 and 8 that reads) on `background`, `card` and
  `muted`; the primary text shade on `background` and `card`. The check
  runs with the theme's own `primary` and with the chosen accent.
- The instance setting (`ui.theme`) holds the accent and the active theme:
  a preset name or the id of a custom theme. Custom themes live in the
  `themes` table, a library of at most 100 documents beside the presets.
  Names are unique, ignoring case, preset names included.
- Light and dark are not modes. `appearance` is a property of a theme: a dark
  theme is activated like any other, and no client follows the device's or
  browser's light or dark setting. Each client draws the active theme's
  appearance (Mantine's colour scheme on the web, the window theme on macOS,
  the colour scheme on Mobile).
- The appearance settings page shows the library as cards: choosing one
  activates it for every client; "New theme" and "Duplicate" open the editor
  on a copy; custom themes can be edited and deleted (not the active one).
  The editor sets only the document's fields (name, appearance, nine colours,
  radius, fonts) and shows the platform's problems, translated, on save.
  `hatch theme` does the same from the CLI.
- A custom theme saved under older rules that no longer passes them is listed
  as needing fixes and cannot be activated; if it is the active one, clients
  draw `desk` until it is fixed.

## Typography

- Sans: **Nunito** (variable, self-hosted), then the system CJK font
  (`PingFang SC`, `Microsoft YaHei UI`, `Noto Sans SC`). No CJK font is bundled.
- Mono: **JetBrains Mono** (variable, self-hosted), for code, identifiers and
  values a user may copy.
- Weights (`fontWeights`): body 500, strong 600, label 700, heading 800. Nunito
  is light for its weight number, so nothing is set below 500.

| Style      | Size / line            | Weight  | Use                                    |
| ---------- | ---------------------- | ------- | -------------------------------------- |
| Display    | 30 / 38                | 800     | Page and window headline (`h1`)        |
| Title      | 24 / 32                | 800     | Page title (`h2`)                      |
| Section    | 20 / 28                | 800     | `h3`                                   |
| Subsection | 17 / 24                | 800     | `h4`, modal title (18)                 |
| Body       | 14 / 20                | 500     | Default text in the product            |
| Body large | 16 / 24                | 500     | Lead paragraphs, chat messages         |
| Label      | 14 / 20                | 700     | Buttons, field labels, nav items, tabs |
| Caption    | 12 / 18                | 500–700 | Meta lines, badges, table headers      |
| Eyebrow    | 11, +0.06em, uppercase | 800     | Group labels above a list              |

Headings use `letter-spacing: -0.01em` and `text-wrap: balance`; paragraphs
use `text-wrap: pretty`.

## Radius

| Token    | px  | Use                                             |
| -------- | --- | ----------------------------------------------- |
| `xs`     | 6   | Small monogram tile, inline code, tags          |
| `sm`     | 9   | Menu items, tooltips, medium tile               |
| `md`     | 12  | Controls: buttons, fields, nav rows, large tile |
| `lg`     | 16  | Menus, popovers, suggestion chips               |
| `tile`   | 18  | Mobile desk tile (60) and launcher tile (56)    |
| `xl`     | 20  | Cards, the composer                             |
| `window` | 24  | Windows, modals, the sign-in card               |
| `widget` | 26  | Desk widget panels, the sign-in hero tile       |
| `dock`   | 28  | The dock and the tab bar                        |

Pills (badges, status chips) are fully rounded. Apart from pills, widget
panels, the dock bar and the ground shapes, a radius never exceeds 24.

## Elevation

Three shadows, all tinted with ink, never black.

| Token    | Value                                   | Use                                                          |
| -------- | --------------------------------------- | ------------------------------------------------------------ |
| `card`   | `0 2px 10px ink 6%`                     | Cards at rest, segmented thumb                               |
| `dock`   | `0 10px 28px ink 12%`                   | Menus, popovers, floating toolbars, a hovered card, the dock |
| `window` | `0 24px 60px ink 16%, 0 2px 6px ink 6%` | Windows, modals, a dragged card                              |

A sheet has a shadow **or** a hairline, not both: a card on the ground floats
on `card`; a group inside a card or window is outlined with the hairline and
stays flat.

## Motion

`motion.easing` is `cubic-bezier(0.25, 1, 0.5, 1)`; `fast` 120 ms for colour
and border changes, `base` 180 ms for movement and shadow, `slow` 260 ms for a
bar that slides in over the page (the dock, the menu bar of a maximized
window). Exposed as `--transition-fast`, `--transition-base`,
`--transition-slow` and `--ease-out-quart`. The three transition variables
already carry the easing, so a declaration adds only a delay after them
(`transform var(--transition-slow) 80ms`), never a second easing, which
would void it. Only things that respond to the pointer move. `prefers-reduced-motion: reduce` collapses
every transition and animation.

## Focus

Every focusable control shows a 2 px ink (`light.ring`) outline, offset 2 px,
on keyboard focus. A field also turns its border to ink. The ring is the same
on the ground, on a sheet and on an accent fill. A widget frame draws the ring
inside its panel, inset 2 px, whenever it has focus: browsers do not report
keyboard focus on a frame separately.

## CSS variables

Besides Mantine's own variables, `cssVariableResolver.ts` sets:

`--surface-panel`, `--surface-dock`, `--surface-widget`, `--radius-widget`, `--ground-shape-accent`,
`--ground-shape-warm`, `--ground-shape-fresh`, `--radius-dock`,
`--size-dock-tile`, `--size-widget-icon`, `--radius-tile`,
`--surface-window`, `--surface-bubble`, `--border-composer`, `--surface-raised`, `--surface-muted`, `--surface-sunken`,
`--surface-hover`, `--surface-pressed`, `--surface-scrim`, `--border-hairline`,
`--border-input`, `--border-glass`, `--on-fill`, `--focus-ring`, `--radius-window`, `--shadow-card`,
`--shadow-dock`, `--shadow-window`, `--font-weight-body`,
`--font-weight-strong`, `--font-weight-label`, `--font-weight-heading`,
`--ease-out-quart`, `--transition-fast`, `--transition-base`, `--transition-slow`.

A surface that would be white on `desk` uses `--surface-raised` (the card) and
its light edge `--border-glass`; `--mantine-color-white` is only for text and
glyphs on a fill, which stay white on every theme.

## Component specification

Sizes are in px. "Accent" is the current accent's shade 6.

### Button

| Property | Small     | Medium (default) | Large     |
| -------- | --------- | ---------------- | --------- |
| Height   | 30        | 36               | 46        |
| Padding  | 0 12      | 0 16             | 0 20      |
| Label    | 13 / 700  | 14 / 700         | 15 / 800  |
| Radius   | 12        | 12               | 12        |
| Icon     | 14, gap 6 | 16, gap 8        | 18, gap 8 |

| Kind        | Rest                                   | Hover       | Pressed            |
| ----------- | -------------------------------------- | ----------- | ------------------ |
| Primary     | accent fill, white label               | shade 7     | shade 7, 1 px down |
| Default     | white fill, hairline border, ink label | hover wash  | pressed wash       |
| Tint        | shade 1 fill, shade 8 label            | shade 2     | shade 2            |
| Subtle      | no fill, ink or shade 8 label          | hover wash  | pressed wash       |
| Destructive | red fill, white label (or red tint)    | red shade 7 | red shade 7        |

Disabled: 50 % opacity, no hover, `not-allowed` cursor. Loading: label
replaced by a spinner, width unchanged. One primary button per view. An
icon-only button is square at the same heights and needs an accessible name.

### Field

Text input, textarea, select and number input share one well.

- Height 36 (large 44); padding 0 12; radius 12; text 14 / 600 ink.
- White fill, 1 px `light.input` border, on the ground and on a sheet.
- Placeholder: muted ink.
- Label above: 14 / 700, shade-7 neutral, gap 6. Description under the label:
  12, muted ink. Error under the field: 12, red shade 7, with the border red.
- Focus: border ink plus the focus ring.
- Disabled: muted-sheet fill, muted ink text, no ring.
- Checkbox and radio: 20 square / circle, neutral shade-5 border, accent fill
  when checked. Switch: 38 × 22 track, neutral shade 4 off, accent on, white
  thumb.
- Segmented control: sunken track, radius 12, white thumb with the `card`
  shadow, labels 14 / 700 (muted until selected).

### Card

- White fill, radius 20, padding 24, `card` shadow, no border.
- Interactive card (the whole card is a link): on hover the shadow becomes
  `dock` and the card rises 1 px; focus ring on the card.
- Grouped content inside a card or window: hairline outline, radius 16, no
  shadow.
- Do not nest a shadowed card in a shadowed card.

### List row

- Min height 46; padding 0 16; gap 12; text 14.
- Rows are separated by a hairline; the first row has none.
- Leading: an optional 34 tile (radius 12, muted-sheet fill, icon 18) or a
  monogram tile. Title 14 / 700 ink; one meta line 12 muted ink.
- Trailing: a value, a status chip, or actions that appear on hover and are
  always visible on touch and on keyboard focus.
- Hover: hover wash. Selected (navigation): accent shade-1 fill, shade-8 text,
  radius 12.
- Table header: 12 / 700 muted ink, height 34; body cells 38 high.

### App tile

A rounded square. Sizes: 22 (radius 6), 26 widget header (radius 9,
`sizes.widgetIcon`), 38 (radius 9), 40 dock (radius 12, `sizes.dockTile`), 44
(radius 12), 56 launcher (radius 18), 60 mobile desk (radius 18,
`sizes.deskTile`), 72 hero (radius 20).

- With an icon: the App's stored icon image, cropped to cover the square. No
  border, shadow or background of its own. Generated icons are one object
  (glossy 3D, frosted glass or a white line drawing) on a top-lit gradient of
  a palette colour (`docs/app-icons.md`).
- Without one: a monogram, the first
  character of the name, white 800 on one of `tiles`, chosen by a stable hash
  of the id, under the `tileLight` overlay. Text from 12 at 22
  up to 26 at 72.

An icon shown inline in a chat message is 96 square with the window radius.

### Status chip and badge

Pill, height 22–26, padding 0 10, 12 / 700. Tint variant by default (shade 1
fill, shade 8 text) with an optional 7 px dot in shade 6. Neutral chip: hover
wash with neutral shade 7. Labels are written in sentence case, never
uppercased.

### Window

The frame a page, a modal or the sign-in form is presented in.

- White fill, radius 24, `window` shadow, `overflow: hidden`.
- Title bar: height 48, padding 0 10 0 16, muted-sheet fill, hairline below.
  Contents: a 22 tile (radius 7), the title 14 / 800, then window buttons.
- Window button: 30 square, radius 10, neutral shade-2 fill, shade-7 icon 14;
  hover neutral shade 3.
- Body padding: 20–40 depending on width. Optional footer: muted-sheet fill,
  hairline above, 13 / 600 muted ink.
- A modal is a window without the tile; its title is 18 / 800 and it sits on
  the scrim. Below 560 wide a window fills the stage and loses its radius.

Every page is shown in this frame (`DeskWindow` in `src/components/desk/`).
Its buttons, in order:

- **Minimise** is shown but disabled until windows can wait on the desk.
- **Maximize / Restore** (double-clicking the title bar does the same).
  Maximized, the window fills the screen edge to edge, with no radius or
  shadow. With a mouse, the menu bar waits above the top edge and slides down
  (`slow`, 80 ms delay) when the pointer reaches the top 6 px or keyboard
  focus enters it; there is no handle. It floats over the top of the window
  rather than pushing it down. The choice is the shell's and is
  remembered per browser, so the next window opens the same way.
- **Close** leads to the window's parent or the desk.

Escape closes the window unless a field or a layer above it wants the key.
Below 560 wide the buttons become one back button at the start of the title
bar.

### Dock tile

- Tile 40 (`sizes.dockTile`), radius 12: the App icon, or a `tiles` fill
  with a white monogram.
- Names under the tiles are an instance setting (`ui.theme.dockLabels`,
  Appearance › Show names in the dock), off by default. Shown: 11 / 700,
  neutral shade 8, one line, ellipsis, tile column 64 wide, gap 5. Hidden:
  the tile column is 52 wide.
- Hover: the tile rises 3 px over 150 ms, and a tooltip above it gives the
  full name whether or not names are shown. Running marker: a 4 px accent
  dot under the name, or 5 under the tile when names are hidden.
- A tile has no button of its own: its actions are in the dock's right-click
  menu (a long press on touch, Shift+F10 or the Menu key from the keyboard).
- Once anything is pinned, the Apps group ends with an All apps tile that is
  not a pin: four 10 dots (teal, orange, violet, blue, shade 6) on a white
  tile with the `card` shadow. It is never dragged and stays visible when the
  pins scroll.
- "Add app" tile: same size, 1.5 px dashed neutral shade-5 border, no fill,
  labelled like any tile. Only an empty Apps group shows it, so a dock with
  no pins shows this tile alone. Otherwise adding lives in the dock's
  right-click menu: the clicked pin's own actions (Edit, Unpin, Manage),
  then Add an app › and New with Agent.
- The dock itself: `surfaces.dock` fill with blur, 1 px white border, radius
  28 (`radius.dock`), `dock` shadow, padding 14 18 8 with names and
  14 18 5 without, so the space above the tiles matches the space under the
  names or under the tiles. The tab bar that replaces it below 560 wide uses
  the same fill, border, radius and shadow.
- With a mouse (`hover: hover`) the dock floats over the stage and takes no
  room: it waits below the bottom edge. While it waits, a 64 × 5 pill in
  neutral shade 5, 6 above the bottom edge and centred, marks where it comes
  from; it fades out (`fast`) while the dock is up. Pointing at the bottom
  6 px of the page, at the pill (a 120 × 16 hit area) or at the dock raises
  it after 80 ms with a `base` slide; it sinks
  300 ms after the pointer leaves. Keyboard focus inside it and an open menu
  of its own hold it up. A right-click does not move focus, like a native
  context menu. On touch it keeps its own row under the stage.

### Widget panel

A widget on the desk, and any panel of the desk's own (the today column, an
empty desk).

- `surfaces.widget` fill with a 12 px backdrop blur, 1 px white border,
  radius 26 (`radius.widget`), `card` shadow; padding 16 18 18.
- Header: a 26 tile (`sizes.widgetIcon`), the name 15 / 800 with ellipsis, and on the right the
  App it comes from as a 12 / 700 muted link ("Plant Care ›"). A refresh
  button appears on hover when the widget supports it.
- Loading: "Loading…" in the header and a skeleton (a circle and three
  lines). Failed: a dashed well with a warning icon, one sentence and Try
  again.
- Editing: a 2 px dashed accent border that turns solid on hover, focus or
  drag (with the `window` shadow while dragged). An edit bar above the
  header holds the Drag handle (arrow keys move by one cell) and the size
  buttons when the widget declares several sizes, else its size as text. A
  30 round ink Remove button sits on the top-right corner, red on hover.

Below 560 widgets become a pager with page dots and "All widgets". The web
desk shows no App tiles: Apps live in the dock and in All apps.

### Empty state

- Centred column, max width 420, gap 12.
- A 56 tile (radius 16, hover-wash or accent shade-1 fill, icon 26).
- Title 20–24 / 800; one or two sentences of body text in muted ink.
- At most one primary button and one subtle button.
- Inside a list or table the empty state shrinks to one muted line of 12–14
  text in place of the rows.

### Agent work line

The Agent's process for one reply (reasoning, tool calls, prose said along
the way) sits above its answer as one line, not as a message. It has no
fill, border or bubble radius.

- Line: min height 28, Body 14 in muted ink, then a chevron 14 that turns
  90° when open. A 12 mark sits in a 14 gutter, so the words line up with the
  text inside the reply bubble below. Hover turns the line to ink.
- Words: the lead word in 700, then the time, then one detail after `·`.
  Running: "Working for 42s · Build the App", the detail being the current
  step ("Thinking", "Writing", "Waiting for you" or the tool's label). Ended:
  "Worked for 1m 12s · 6 steps", where steps count tool calls and context
  compactions. "Failed after", "Stopped after" and "Ended early after" name
  the other ends. Without a known time the line is the lead word and detail.
- Mark: running is the running marker, a 7 dot in the accent with a ring that
  fades out over 1.6 s (still under reduced motion). Failed: alert triangle,
  red shade 7, which also colours the lead word. Ended early: alert circle,
  amber shade 8, likewise. Stopped: a filled stop square in muted ink.
  Worked: no mark.
- Open: the steps hang off a 1 px hairline rail through the mark's centre;
  step icons sit on the text column. A finished reply folds; a running,
  failed, stopped or ended-early one stays open.

### Menu, popover, tooltip

Menu and popover: white, hairline border, radius 16, `dock` shadow, padding 6;
items 32 high, radius 9, 14 / 600, hover wash. Tooltip: ink fill, white text
12 / 600, radius 9.

A right-click menu belongs to a group of tiles (the dock, All apps), not to
each tile: right-clicking a tile shows that tile's actions first, then the
group's. It opens by right-click, by a long press on touch, and by Shift+F10
or the Menu key on a focused tile, so it has a keyboard path on every
platform. A tile carries no ⋯ button; a hover card (500 ms delay, 280 wide)
may describe it, and is hidden while the menu is open.

## Apps

Native-runtime Apps draw these components from `@hatch/ui`
(`sdk-internal/ui`), whose theme `buildAppTheme` builds from the same
`tokens.json` and the instance accent. The App-side rules, screen patterns
and the catalogue are in `skills/building-apps/references/design-system.md`.

- `AppShell` follows the App's own pane, not the screen: a sidebar from 720
  points wide, below that a bottom tab bar on touch screens and a row of
  tabs at the top with a pointer. An App in a narrow Desk window lays out as
  on a phone.
- The selected section and the pages of a `NavStack` are the App's address,
  and the shown `Page`'s title is the window's title, so deep links and
  reloads land on the same screen.

## Conventions

- Links are underlined, accent shade 7, weight 700.
- Sentence case everywhere; UI copy is English.
- Use Mantine components and props before custom CSS; custom CSS lives in a
  CSS module next to its component and uses variables only.
