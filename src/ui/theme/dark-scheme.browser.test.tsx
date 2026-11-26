/**
 * Mantine parts whose dark-scheme defaults pair `black` with a theme colour
 * stay readable on a dark theme.
 */
import { MantineProvider, Tooltip, Typography } from '@mantine/core';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import chatClasses from '~components/agent/chat.module.css';
import {
  contrast,
  resolvePreset,
  resolveTheme,
  THEME_PRESETS,
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

test('custom fills of a pale primary carry its paired label colour', async () => {
  // A valid dark theme whose grey primary needs dark text, not white.
  const document = {
    ...THEME_PRESETS['desk-dark'].document,
    colors: {
      ...THEME_PRESETS['desk-dark'].document.colors,
      primary: '#818181',
    },
  };
  const theme = resolveTheme(document, { name: 'Grey', source: 'custom' });
  const screen = await render(
    <MantineProvider
      theme={deskThemeFor(theme)}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme="dark"
    >
      <div className={chatClasses.userBubble}>Ship it</div>
    </MantineProvider>,
  );
  const bubble = screen.getByText('Ship it').element();
  expect(hex(getComputedStyle(bubble).color)).toBe(
    theme.colors['primary-foreground'].toLowerCase(),
  );
  expect(readable(bubble)).toBeGreaterThanOrEqual(4.5);
});
