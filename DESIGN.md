# Design

"Desk" is the visual system of Hatch: a warm cream desk, white sheets that
float on it, rounded heavy type, and one accent colour. This file describes the
tokens and specifies the components built from them. It is written so that a
second implementation (the planned `@hatch/ui` App component library) can be
built from it without reading the platform's React code.

Hatch is light-only. The tokens keep an empty `dark` slot; nothing reads it.

## Where values live

| What                                   | Where                                                  |
| -------------------------------------- | ------------------------------------------------------ |
| Every colour, radius, font and shadow  | `packages/hatch-design-tokens/tokens.json`             |
| Mantine theme built from the tokens    | `src/ui/theme/theme.ts`                                |
| CSS variables and Mantine colour roles | `src/ui/theme/cssVariableResolver.ts`                  |
| Surface treatment of Mantine parts     | `src/ui/theme/desk.css`                                |
| Font files                             | `@fontsource-variable/*`, imported in `src/styles.css` |

`tokens.json` is imported as JSON; there is no generation step. Do not write a
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

| Role            | Token                       | Value        | Use                                                                      |
| --------------- | --------------------------- | ------------ | ------------------------------------------------------------------------ |
| Ground          | `light.background`          | `#EDEBE6`    | The desk: page background                                                |
| Ink             | `light.foreground`          | `#1E2230`    | Text, icons, focus ring                                                  |
| Muted ink       | `light.muted-foreground`    | `#4F5666`    | Secondary text, placeholders, table headers                              |
| Sheet           | `light.card`, `popover`     | `#FFFFFF`    | Cards, windows, menus, fields                                            |
| Muted sheet     | `light.muted`, `secondary`  | `#F6F5F1`    | Window title bars, read-only wells, code blocks in a card                |
| Sunken          | `surfaces.sunken`           | `#E4E2DC`    | Segmented-control track                                                  |
| Panel           | `surfaces.panel`            | white 72%    | Translucent chrome over the ground: sidebar now, menu bar and dock later |
| Hairline        | `surfaces.hairline`         | ink 14%      | Dividers and outlines; reads on ground and sheet                         |
| Field border    | `light.input`               | `#D5D1C8`    | Border of a field                                                        |
| Hover / pressed | `surfaces.hover`, `pressed` | ink 6% / 10% | Hover wash, neutral tint, skeletons                                      |
| Scrim           | `surfaces.scrim`            | ink 45%      | Behind modals; over thumbnails                                           |
| Destructive     | `light.destructive`         | `#B91C1C`    | Same value as `hues.red`                                                 |

`light.border` (`#ECEAE4`) is kept for the App theme, where borders sit on
white. The platform uses the hairline instead because `#ECEAE4` disappears on
the ground.

### Accent

One accent at a time, default `indigo` `#3F51C7`; alternatives `teal`
`#0F766E`, `clay` `#B4472A`, `violet` `#7A3FB8`. `accentRamp(name)` in
`theme.ts` turns an accent into Mantine's `primary` ramp. The accent is used
for the primary action of a view, the current navigation item, selection and
links. It is not used for decoration.

### Ramps

Mantine needs ten shades per colour. Tokens store one value per colour and
`colorRamp()` derives the rest: the token is shade 6; shades 0–5 mix it with
white (92, 86, 72, 50, 30, 14 %), shades 7–9 mix it with black (16, 32, 48 %).

| Variant      | Fill                 | Text                    |
| ------------ | -------------------- | ----------------------- |
| filled       | shade 6              | white                   |
| filled hover | shade 7              | white                   |
| light (tint) | shade 1, hover 2     | shade 8                 |
| outline      | transparent, hover 0 | shade 7, border shade 7 |
| text, link   | —                    | shade 7                 |

Every pairing in this table is at least 4.5:1 for all accents and hues.

`neutral` is written out in full (ten steps from `#FAF9F6` to ink) and backs
Mantine's `gray` and `dark`. Its tint variant is the hover wash with shade-7
text, so a neutral badge reads on the ground and on a sheet.

### Hues and status

`hues` holds the eight chromatic colours: red, orange, amber, green, teal,
blue, violet, pink. Mantine names map onto them (`yellow` → amber, `grape` →
violet). Status meaning: red = error or destructive, amber = warning, green =
success, blue = information. Colour never carries state alone; pair it with an
icon or a word.

`tiles` holds eleven saturated fills for monogram tiles. All carry white text
at 4.5:1 or better.

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
| `xl`     | 20  | Cards, the composer                             |
| `window` | 24  | Windows, modals, the sign-in card               |

Pills (badges, status chips) are fully rounded. A radius never exceeds 24
except on a pill.

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
and border changes, `base` 180 ms for movement and shadow. Exposed as
`--transition-fast`, `--transition-base` and `--ease-out-quart`. Only things
that respond to the pointer move. `prefers-reduced-motion: reduce` collapses
every transition and animation.

## Focus

Every focusable control shows a 2 px ink (`light.ring`) outline, offset 2 px,
on keyboard focus. A field also turns its border to ink. The ring is the same
on the ground, on a sheet and on an accent fill.

## CSS variables

Besides Mantine's own variables, `cssVariableResolver.ts` sets:

`--surface-panel`, `--surface-raised`, `--surface-muted`, `--surface-sunken`,
`--surface-hover`, `--surface-pressed`, `--surface-scrim`, `--border-hairline`,
`--border-input`, `--focus-ring`, `--radius-window`, `--shadow-card`,
`--shadow-dock`, `--shadow-window`, `--font-weight-body`,
`--font-weight-strong`, `--font-weight-label`, `--font-weight-heading`,
`--ease-out-quart`, `--transition-fast`, `--transition-base`.

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

### Monogram tile

A rounded square with the first character of a name, white 800 on one of
`tiles`, chosen by a stable hash of the id. Sizes: 22 (radius 6, text 12), 38
(radius 9, text 18), 44 (radius 12, text 21).

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

Today modals and the sign-in card use this frame. Pages move into it with the
shell in a later step.

### Dock tile

- Tile 40, radius 12, a `tiles` fill, white icon 22 or monogram.
- Label under the tile: 11 / 700, neutral shade 8, one line, ellipsis, tile
  column 64 wide, gap 5.
- Hover: the tile rises 3 px over 150 ms. Running marker: a 4 px accent dot
  under the label.
- "Add" tile: same size, 1.5 px dashed neutral shade-5 border, no fill.
- Workflow tiles use radius `12 12 12 3` to differ from App tiles by shape.
- The dock itself: panel fill with blur, 1 px white border, radius 28, `dock`
  shadow, padding 10 18 12.

### Empty state

- Centred column, max width 420, gap 12.
- A 56 tile (radius 16, hover-wash or accent shade-1 fill, icon 26).
- Title 20–24 / 800; one or two sentences of body text in muted ink.
- At most one primary button and one subtle button.
- Inside a list or table the empty state shrinks to one muted line of 12–14
  text in place of the rows.

### Menu, popover, tooltip

Menu and popover: white, hairline border, radius 16, `dock` shadow, padding 6;
items 32 high, radius 9, 14 / 600, hover wash. Tooltip: ink fill, white text
12 / 600, radius 9.

## Conventions

- Links are underlined, accent shade 7, weight 700.
- Sentence case everywhere; UI copy is English.
- Use Mantine components and props before custom CSS; custom CSS lives in a
  CSS module next to its component and uses variables only.
