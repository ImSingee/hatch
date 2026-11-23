import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const fixtures = vi.hoisted(() => ({ status: 'running' }));

vi.mock('~queries/workflows', () => ({
  allWorkflowRunsQueryOptions: {
    queryKey: ['test-runs'],
    queryFn: async () => [
      {
        id: 'run-1',
        workflowId: 'wf-1',
        workflowSlug: 'digest',
        workflowName: 'Morning digest',
        status: fixtures.status,
        trigger: 'cron',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      },
    ],
  },
}));

test('a run in progress on the desk updates without a reload', async () => {
  const { TodayPanel } = await import('./today-panel');
  const router = createRouter({
    routeTree: createRootRoute({ component: TodayPanel }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await expect.element(screen.getByText('Running')).toBeVisible();

  fixtures.status = 'succeeded';
  // While a run is in flight the panel polls every few seconds.
  await expect
    .element(screen.getByText('Done'), { timeout: 8_000 })
    .toBeVisible();
});
