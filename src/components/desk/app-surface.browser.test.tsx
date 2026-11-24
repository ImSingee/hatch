import { MantineProvider } from '@mantine/core';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  PlatformEventsContext,
  type PlatformEventListener,
} from '~components/system/platform-events-context';
import type { PlatformEvent } from '~server/platform-events';
import { applyAccent } from '~/ui/theme';
import { AppSurface, type AppSurfaceHandle } from './app-surface';

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
  const listeners = new Set<PlatformEventListener>();
  const events = {
    subscribe: (listener: PlatformEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeResync: () => () => {},
  };
  const emit = (event: PlatformEvent) => {
    for (const listener of listeners) listener(event);
  };
  const surface = (visible: boolean) => (
    <MantineProvider>
      <PlatformEventsContext.Provider value={events}>
        <AppSurface
          ref={handle}
          app={{ slug: 'native-notes', name: 'Notes' }}
          route="/inbox"
          visible={visible}
          onRouteChange={onRouteChange}
          onTitleChange={onTitleChange}
        />
      </PlatformEventsContext.Provider>
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
    visible: true,
  });
  // The page's own title and fragment are the player's, not the App's.
  expect(onTitleChange).not.toHaveBeenCalledWith('Native player');
  expect(player().location.hash).toBe('');

  handle.current!.navigate('/settings');
  await vi.waitFor(() =>
    expect(onRouteChange).toHaveBeenLastCalledWith('/settings'),
  );

  applyAccent('teal');
  await screen.rerender(surface(false));
  await vi.waitFor(() =>
    expect(player().received).toEqual(
      expect.arrayContaining([
        { type: 'navigate', route: '/settings' },
        { type: 'theme', accent: 'teal' },
        { type: 'visibility', visible: false },
      ]),
    ),
  );
  applyAccent('indigo');

  // Another App's deployment is not an update for this one; a newer
  // deployment of the App the player runs (`native-app`, `d1`) is.
  emit({
    type: 'app.deployment.activated',
    appId: 'other-app',
    deploymentRevision: 'x9',
  });
  emit({
    type: 'app.deployment.activated',
    appId: 'native-app',
    deploymentRevision: 'd2',
  });
  await vi.waitFor(() =>
    expect(player().received).toContainEqual({ type: 'update-available' }),
  );
  expect(
    player().received.filter(
      (message) => (message as { type: string }).type === 'update-available',
    ),
  ).toHaveLength(1);
});
