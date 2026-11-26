import { MantineProvider } from '@mantine/core';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { resolvePreset } from '../../../packages/hatch-design-tokens/src';
import { applyThemeState, type WebThemeState } from '~/ui/theme';
import { AppSurface, type AppSurfaceHandle } from './app-surface';
import { usePlatformShortcut } from './platform-shortcuts';

/** The instance theme with an accent, as the root applies it. */
function themeWith(accent: 'indigo' | 'teal'): WebThemeState {
  const color = accent === 'teal' ? '#0F766E' : '#3F51C7';
  return { accent, theme: resolvePreset('desk', color) };
}

// Browser Mode serves a blank same-origin document titled "Embedded app" at
// `/app/<slug>/embed/` (see vitest.config.ts).

async function renderSurface(route: string) {
  const handle = createRef<AppSurfaceHandle>();
  const onRouteChange = vi.fn<(route: string) => void>();
  const onTitleChange = vi.fn<(title: string | null) => void>();
  const screen = await render(
    <MantineProvider>
      <AppSurface
        ref={handle}
        app={{ slug: 'notes', name: 'Notes' }}
        route={route}
        onRouteChange={onRouteChange}
        onTitleChange={onTitleChange}
      />
    </MantineProvider>,
  );
  const frame = () => screen.container.querySelector('iframe')!;
  const appWindow = () => frame().contentWindow!;
  await vi.waitFor(() => expect(onTitleChange).toHaveBeenCalled());
  return { handle, onRouteChange, onTitleChange, frame, appWindow };
}

test('loads the App at the given route and reports its title and route', async () => {
  const { onRouteChange, onTitleChange, appWindow } =
    await renderSurface('/settings');

  expect(appWindow().location.pathname).toBe('/app/notes/embed/');
  expect(appWindow().location.hash).toBe('#/settings');
  expect(onTitleChange).toHaveBeenLastCalledWith('Embedded app');
  expect(onRouteChange).toHaveBeenLastCalledWith('/settings');

  appWindow().history.pushState(null, '', '#/inbox');
  appWindow().document.title = 'Inbox';
  await vi.waitFor(() => {
    expect(onRouteChange).toHaveBeenLastCalledWith('/inbox');
    expect(onTitleChange).toHaveBeenLastCalledWith('Inbox');
  });
});

test('navigates the running App without reloading it or adding history', async () => {
  const { handle, onRouteChange, frame, appWindow } = await renderSurface('');
  const loaded = frame();
  const entries = appWindow().history.length;

  handle.current!.navigate('/a%2520b');

  await vi.waitFor(() =>
    expect(onRouteChange).toHaveBeenLastCalledWith('/a%2520b'),
  );
  expect(appWindow().location.hash).toBe('#/a%2520b');
  expect(appWindow().history.length).toBe(entries);
  expect(frame()).toBe(loaded);
});

test('reload loads the App again', async () => {
  const { handle, onTitleChange, frame, appWindow } =
    await renderSurface('/settings');
  const loaded = frame();
  appWindow().document.title = 'Stale';
  await vi.waitFor(() =>
    expect(onTitleChange).toHaveBeenLastCalledWith('Stale'),
  );

  handle.current!.reload();

  await vi.waitFor(() => {
    expect(frame()).not.toBe(loaded);
    expect(onTitleChange).toHaveBeenLastCalledWith('Embedded app');
  });
  expect(appWindow().location.hash).toBe('#/settings');
});

test('runs a native App over the player channel instead of reading its frame', async () => {
  const handle = createRef<AppSurfaceHandle>();
  const onRouteChange = vi.fn<(route: string) => void>();
  const onTitleChange = vi.fn<(title: string | null) => void>();
  const surface = (visible: boolean, latestDeployment = 'd1') => (
    <MantineProvider>
      <AppSurface
        ref={handle}
        app={{ slug: 'native-notes', name: 'Notes' }}
        route="/inbox"
        visible={visible}
        onRouteChange={onRouteChange}
        onTitleChange={onTitleChange}
        latestDeployment={latestDeployment}
      />
    </MantineProvider>
  );
  const screen = await render(surface(true));
  const player = () =>
    screen.container.querySelector('iframe')!.contentWindow! as Window & {
      received: unknown[];
    };

  // The player starts the App where the host asked, in the host's accent,
  // and its route and title come back over the channel.
  await vi.waitFor(() => {
    expect(onTitleChange).toHaveBeenLastCalledWith('Native home');
    expect(onRouteChange).toHaveBeenLastCalledWith('/inbox');
  });
  expect(player().received[0]).toEqual({
    type: 'init',
    route: '/inbox',
    accent: 'indigo',
    themeKey: expect.any(String),
    visible: true,
  });
  // The page's own title and fragment are the player's, not the App's.
  expect(onTitleChange).not.toHaveBeenCalledWith('Native player');
  expect(player().location.hash).toBe('');

  handle.current!.navigate('/settings');
  await vi.waitFor(() =>
    expect(onRouteChange).toHaveBeenLastCalledWith('/settings'),
  );

  applyThemeState(themeWith('teal'));
  await screen.rerender(surface(false));
  await vi.waitFor(() =>
    expect(player().received).toEqual(
      expect.arrayContaining([
        { type: 'navigate', route: '/settings' },
        {
          type: 'theme',
          accent: 'teal',
          themeKey: expect.any(String),
        },
        { type: 'visibility', visible: false },
      ]),
    ),
  );
  applyThemeState(themeWith('indigo'));

  // The player runs `d1`, as the host knows it: no notice. Once the host's
  // live deployment moves on (an event, or a re-read after a reconnect),
  // the App is told once.
  const updates = () =>
    player().received.filter(
      (message) => (message as { type: string }).type === 'update-available',
    );
  expect(updates()).toHaveLength(0);
  await screen.rerender(surface(false, 'd2'));
  await vi.waitFor(() => expect(updates()).toHaveLength(1));
  await screen.rerender(surface(true, 'd2'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(updates()).toHaveLength(1);
});

const MOD = /mac/i.test(navigator.platform) ? 'Meta' : 'Control';

function PaletteShortcut({ onRun }: { onRun: () => void }) {
  usePlatformShortcut('palette.open', onRun);
  return null;
}

async function renderWithShortcut(
  reservedShortcuts?: string[],
  slug = 'notes',
) {
  const onRun = vi.fn<() => void>();
  const onTitleChange = vi.fn<(title: string | null) => void>();
  const screen = await render(
    <MantineProvider>
      <PaletteShortcut onRun={onRun} />
      <AppSurface
        app={{ slug, name: 'Notes' }}
        route=""
        reservedShortcuts={reservedShortcuts}
        onTitleChange={onTitleChange}
      />
    </MantineProvider>,
  );
  await vi.waitFor(() => expect(onTitleChange).toHaveBeenCalled());
  const frame = screen.container.querySelector('iframe')!;
  const doc = frame.contentDocument!;
  // A field inside the App: platform shortcuts work while typing too.
  const field = doc.createElement('input');
  doc.body.append(field);
  field.focus();
  const appKeys: KeyboardEvent[] = [];
  doc.addEventListener('keydown', (event) => appKeys.push(event));
  return { onRun, appKeys };
}

test('platform shortcuts work while focus is inside the App', async () => {
  const { onRun, appKeys } = await renderWithShortcut();

  await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);

  expect(onRun).toHaveBeenCalledOnce();
  expect(appKeys.filter((event) => event.key === 'k')).toEqual([]);
});

test('an App that reserves a chord receives it instead of the platform', async () => {
  const { onRun, appKeys } = await renderWithShortcut(['mod+K']);

  await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);

  const pressed = appKeys.filter((event) => event.key === 'k');
  expect(pressed).toHaveLength(1);
  expect(pressed[0].defaultPrevented).toBe(false);
  expect(onRun).not.toHaveBeenCalled();
});

test('platform shortcuts also work inside a native App', async () => {
  // `native-*` slugs get the stand-in player page (vitest.config.ts).
  const { onRun, appKeys } = await renderWithShortcut(
    undefined,
    'native-notes',
  );

  await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);

  expect(onRun).toHaveBeenCalledOnce();
  expect(appKeys.filter((event) => event.key === 'k')).toEqual([]);
});
