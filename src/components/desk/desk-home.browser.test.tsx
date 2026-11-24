import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';
import { DeskHome } from './desk-home';

function Harness() {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setEditing((value) => !value)}>
        Toggle editor
      </button>
      <DeskHome
        title="My desk"
        actions={<button type="button">Desk action</button>}
        toolbar={<button type="button">Edit widgets</button>}
        editing={editing}
        editor={<h1>Edit desk layout</h1>}
        editorPanel={<aside>Add widgets</aside>}
      >
        <iframe title="Widget runtime" srcDoc="<p>Widget content</p>" />
      </DeskHome>
    </>
  );
}

// Widgets are frames with running state, so entering and leaving the layout
// editor swaps everything around them but must not load them again.
test('swaps the heading for the editor without remounting the widgets', async () => {
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
    .element(screen.getByRole('heading', { name: 'Edit desk layout' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('heading', { name: 'My desk' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Edit widgets' }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText('Add widgets')).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBe(widget);

  await screen.getByRole('button', { name: 'Toggle editor' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'My desk' }))
    .toBeVisible();
  expect(screen.container.querySelector('iframe')).toBe(widget);
});
