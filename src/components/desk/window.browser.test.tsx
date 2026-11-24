import { MantineProvider } from '@mantine/core';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { WindowFrameProvider, type WindowFrame } from './desk-context';
import { DeskWindow } from './window';

async function renderWindow(frame?: WindowFrame) {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => {
      const window = (
        <DeskWindow
          title="Settings"
          toolbar={<button type="button">Save</button>}
        >
          Body
        </DeskWindow>
      );
      return frame ? (
        <WindowFrameProvider value={frame}>{window}</WindowFrameProvider>
      ) : (
        window
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  const screen = await render(
    <MantineProvider>
      <RouterProvider router={router} />
    </MantineProvider>,
  );
  await expect
    .element(screen.getByRole('heading', { name: 'Settings' }))
    .toBeVisible();
  return screen;
}

test('a window on the desk keeps its own close, with minimise shown but disabled', async () => {
  const screen = await renderWindow();
  await expect
    .element(screen.getByRole('button', { name: 'Minimise window' }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole('link', { name: /^Close window/ }))
    .toBeVisible();
  const bar = screen
    .getByRole('heading', { name: 'Settings' })
    .element().parentElement!;
  expect(bar.hasAttribute('data-tauri-drag-region')).toBe(false);
});

test('a window in a native host leaves its frame to the host', async () => {
  const screen = await renderWindow('host');
  expect(
    screen.container.querySelector('[aria-label^="Minimise window"]'),
  ).toBeNull();
  expect(
    screen.container.querySelector('[aria-label^="Close window"]'),
  ).toBeNull();
  // The title bar moves the native window; its own controls stay usable.
  const bar = screen
    .getByRole('heading', { name: 'Settings' })
    .element().parentElement!;
  expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep');
  await expect
    .element(screen.getByRole('button', { name: 'Save' }))
    .toBeEnabled();
});
