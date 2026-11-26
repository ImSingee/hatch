/**
 * Mantine parts whose dark-scheme defaults pair `black` with a theme colour
 * stay readable on a dark theme.
 */
import { MantineProvider, Tooltip, Typography } from '@mantine/core';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  contrast,
  resolvePreset,
} from '../../../packages/hatch-design-tokens/src';
import { cssVariablesResolver } from './cssVariableResolver';
import { deskThemeFor } from './theme';

/** `rgb(r, g, b)` as `#RRGGBB`. */
function hex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function readable(element: Element) {
  const style = getComputedStyle(element);
  return contrast(hex(style.color), hex(style.backgroundColor));
}

test('tooltips and highlighted text read at 4.5:1 on desk-dark', async () => {
  const screen = await render(
    <MantineProvider
      theme={deskThemeFor(resolvePreset('desk-dark'))}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme="dark"
    >
      <Tooltip label="Backend stopped" opened>
        <button type="button">Status</button>
      </Tooltip>
      <Typography>
        <p>
          Found <mark>three</mark> notes
        </p>
      </Typography>
    </MantineProvider>,
  );
  await expect.element(screen.getByText('Backend stopped')).toBeVisible();
  const tooltip = document.querySelector('.mantine-Tooltip-tooltip')!;
  expect(readable(tooltip)).toBeGreaterThanOrEqual(4.5);
  expect(readable(document.querySelector('mark')!)).toBeGreaterThanOrEqual(4.5);
});
