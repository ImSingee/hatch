# Desk theme

The platform's Mantine theme, drawn from the instance theme at run time.
Design rules, the theme document and the component specification are in
[`DESIGN.md`](../../../DESIGN.md).

- `packages/hatch-design-tokens` holds the theme data and logic shared by the
  server, the CLI, the web, the mobile app and the native UI library:
  `tokens.json` (the `desk` values, the `desk-dark` document, weights, sizes,
  motion), and `src/` (`resolveTheme`, the presets, validation and colour
  arithmetic). The server resolves the instance theme; clients do not derive
  tokens themselves.
- `theme-store.ts` holds the theme this browser draws: the mode, the accent
  and the resolved light and dark themes from `~queries/theme`, cached in
  `localStorage` (`hatch.theme.v1`) so a reload paints the right theme before
  the setting is fetched. `useActiveTheme()` picks light or dark from the mode
  and, in `system` mode, the device. `THEME_BOOT_SCRIPT` paints the cached
  ground and colour scheme before React mounts; `applyDocumentTheme()` keeps it
  and `<meta name="theme-color">` (read by the macOS app) current.
  `useSurfaceTheme()` is what App surfaces send their native players.
- `theme.ts` builds the Mantine theme from a resolved theme
  (`deskThemeFor(resolved)`, one object per theme). A dark theme switches
  Mantine to its dark colour scheme and fills its `dark` palette from the
  theme, so Mantine's own components draw dark; `gray` is the theme's neutral
  ramp, ordered surface to ink, in both.
- `cssVariableResolver.ts` sets Mantine's colour roles and the Desk variables
  (`--surface-*`, `--border-*`, `--shadow-*`, `--focus-ring`, …) from the
  resolved theme the Mantine theme carries (`theme.other.resolved`), the same
  for both colour schemes.
- `desk.css` styles Mantine parts with those variables. It contains no literal
  colour, radius or shadow.
- `accents.ts` lists the accents from the tokens without importing Mantine,
  so the server and the CLI validate against the same list. `accent-store.ts`
  keeps the accent name in `localStorage` (`hatch.accent`) for native App
  players.
- `index.ts` exports `appTheme` (the built-in `desk`) and
  `appCssVariablesResolver` for tests that render outside the root.

`packages/hatch-design-tokens/test/desk-golden.json` freezes what `desk`
looked like before themes became data; tests on the web, the mobile app and
the native UI library check that `desk` still draws exactly that. To change a
`desk` value, edit `tokens.json` and regenerate that file deliberately. To add
a colour name components can use (`color="…"`), add the hue to `tokens.json`
and map it in `HUE_BY_COLOR_NAME`.
