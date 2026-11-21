import { MantineProvider } from '@mantine/core';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
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
