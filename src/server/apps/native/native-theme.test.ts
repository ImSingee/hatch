/** How the native App player learns and reads the instance theme. */
import { describe, expect, it, vi } from 'vitest';
import { fetchInstanceTheme } from '../../../../sdk-internal/app/src/native-player';
import { parseSurfaceMessage } from '../../../../sdk-internal/app/src/native-surface';

const theme = { cssVars: { theme: {}, light: { background: '#17191F' } } };

describe('the native player theme', () => {
  it('accepts theme messages with and without the theme identity', () => {
    expect(parseSurfaceMessage({ type: 'theme', accent: 'teal' })).toEqual({
      type: 'theme',
      accent: 'teal',
    });
    expect(
      parseSurfaceMessage({
        type: 'init',
        route: '',
        accent: 'teal',
        visible: true,
        themeKey: 'a1b2',
      }),
    ).toEqual({
      type: 'init',
      route: '',
      accent: 'teal',
      visible: true,
      themeKey: 'a1b2',
    });
    for (const bad of [
      { type: 'theme', accent: 'teal', themeKey: 7 },
      { type: 'theme', accent: 'teal', themeKey: 'k'.repeat(129) },
    ])
      expect(parseSurfaceMessage(bad)).toBeNull();
  });

  it('reads the active theme from the platform', async () => {
    const fetcher = vi.fn<(url: string) => Promise<Response>>(
      async () => new Response(JSON.stringify({ key: 'k1', theme })),
    );
    expect(await fetchInstanceTheme(fetcher as never)).toEqual({
      key: 'k1',
      theme,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/theme/native',
    ]);
  });

  it('keeps the built-in theme when the platform gives no usable answer', async () => {
    for (const response of [
      () => new Response('missing', { status: 404 }),
      () => new Response('not json'),
      () => new Response(JSON.stringify({ key: 'k1' })),
      () => new Response(JSON.stringify({ key: 1, theme })),
      () => {
        throw new TypeError('offline');
      },
    ])
      expect(
        await fetchInstanceTheme((async () => response()) as never),
      ).toBeNull();
  });
});
