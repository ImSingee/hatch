# Desk theme

The platform's Mantine theme. Design rules and the component specification are
in [`DESIGN.md`](../../../DESIGN.md).

- `packages/hatch-design-tokens/tokens.json` holds every colour, radius, font,
  weight, shadow and motion value. It is imported as JSON; nothing is
  generated.
- `theme.ts` builds the Mantine theme: `colorRamp()` derives a ten-shade ramp
  from one token colour, `accentRamp()` does it for a named accent (the
  `primary` palette), and the neutral ramp backs `gray` and `dark`.
- `cssVariableResolver.ts` sets Mantine's colour roles (body, text, borders,
  the light/outline variants of each palette) and the Desk variables
  (`--surface-*`, `--border-*`, `--shadow-*`, `--focus-ring`, …).
- `desk.css` styles Mantine parts with those variables: surfaces, fields,
  focus ring, type weights. It contains no literal colour, radius or shadow.
- `index.ts` exports `appTheme` and `appCssVariablesResolver` for
  `MantineProvider`, plus `TILE_COLORS` for monogram tiles.

To change a value, edit `tokens.json`. To add a colour name components can use
(`color="…"`), add the hue to `tokens.json` and map it in `HUE_BY_COLOR_NAME`.
