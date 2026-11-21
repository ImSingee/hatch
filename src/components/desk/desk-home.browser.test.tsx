import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DeskHome } from './desk-home';

vi.mock('~queries/sidebar', () => ({
  sidebarItemsQueryOptions: {
    queryKey: ['test-pins'],
    queryFn: async () => [],
  },
}));
vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [],
  },
}));

function Harness() {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setEditing((value) => !value)}>
        Toggle editor
      </button>
      <DeskHome
        title="My desk"
        description="Desk description"
        actions={<button type="button">Desk action</button>}
        hideHeader={editing}
      >
        <iframe title="Widget runtime" srcDoc="<p>Widget content</p>" />
      </DeskHome>
    </>
  );
}

// The layout editor hides the heading; widgets are frames with running
// state, so entering and leaving the editor must not load them again.
test('hides the heading without remounting the widgets', async () => {
  const router = createRouter({
    routeTree: createRootRoute({ component: Harness }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await expect
    .element(screen.getByRole('heading', { name: 'My desk' }))
    .toBeVisible();
  const widget = screen.container.querySelector('iframe');

  await screen.getByRole('button', { name: 'Toggle editor' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'My desk' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Desk action' }))
    .not.toBeInTheDocument();
  expect(screen.container.querySelector('iframe')).toBe(widget);

  await screen.getByRole('button', { name: 'Toggle editor' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'My desk' }))
    .toBeVisible();
  expect(screen.container.querySelector('iframe')).toBe(widget);
});
