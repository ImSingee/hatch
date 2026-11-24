import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import type { AppListItem } from '~server/apps';

const fixtures = vi.hoisted(() => ({
  pins: [] as { id: string; appId: string }[],
  pinCalls: [] as unknown[],
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [
      {
        id: 'wf-1',
        slug: 'morning-digest',
        name: 'Morning Digest',
        description: null,
        status: 'deployed',
        pinned: false,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:00:00.000Z',
      },
    ],
  },
}));
vi.mock('~queries/sidebar', () => ({
  sidebarItemsQueryOptions: {
    queryKey: ['test-pins'],
    queryFn: async () => fixtures.pins,
  },
}));
vi.mock('~server/sidebar', () => ({
  setSidebarPin: async (input: {
    data: { appId: string; pinned: boolean };
  }) => {
    fixtures.pinCalls.push(input.data);
    if (input.data.pinned)
      fixtures.pins = [{ id: 'pin-1', appId: input.data.appId }];
  },
}));
vi.mock('~server/workflows', () => ({ setWorkflowPinFn: async () => {} }));
vi.mock('~queries/dashboards', () => ({
  dashboardsQueryOptions: {
    queryKey: ['test-dashboards'],
    queryFn: async () => [{ id: 'home', name: 'My Dashboard' }],
  },
  availableWidgetsQueryOptions: {
    queryKey: ['test-available'],
    queryFn: async () => [],
  },
  dashboardQueryOptions: (id: string) => ({
    queryKey: ['dashboard', 'widgets', id],
    queryFn: async () => ({ widgets: [] }),
  }),
}));
vi.mock('~server/dashboards', () => ({ addDashboardWidget: async () => ({}) }));
vi.mock('~components/apps/use-app-icon', () => ({
  appIconUrl: () => '',
  useAppIconKey: () => null,
  useHasAppIcons: () => false,
}));

const APPS: AppListItem[] = [
  {
    id: 'app-1',
    slug: 'budget-buddy',
    name: 'Budget Buddy',
    description: 'Splits the rent between flatmates.',
    status: 'deployed',
    capabilities: { frontend: true } as AppListItem['capabilities'],
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
  },
];

async function renderLibrary() {
  const { AppLibrary } = await import('./app-library');
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <p>Opened {path}</p>,
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/apps',
        component: () => <AppLibrary apps={APPS} />,
      }),
      page('/app/$appSlug'),
      page('/app/$appSlug/manage'),
      page('/workflow/$workflowSlug'),
      page('/workflow/$workflowSlug/manage'),
      page('/agent'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/apps'] }),
  });
  const screen = await render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { screen, path: () => router.state.location.pathname };
}

beforeEach(() => {
  fixtures.pins = [];
  fixtures.pinCalls = [];
});

test('a click opens an App or Workflow straight away, with no detail panel', async () => {
  const { screen, path } = await renderLibrary();
  const budget = screen.getByRole('link', { name: /Budget Buddy/ });
  await expect.element(budget).toHaveAttribute('href', '/app/budget-buddy');
  await expect
    .element(screen.getByRole('link', { name: /Morning Digest/ }))
    .toHaveAttribute('href', '/workflow/morning-digest');
  expect(screen.container.querySelector('aside')).toBeNull();

  await budget.click();
  await vi.waitFor(() => expect(path()).toBe('/app/budget-buddy'));
});

test('pointing shows the details; the actions are in the right-click menu and on Shift+F10', async () => {
  const { screen, path } = await renderLibrary();
  const budget = screen.getByRole('link', { name: /Budget Buddy/ });
  await budget.hover();
  await expect
    .element(screen.getByText('Splits the rent between flatmates.'))
    .toBeVisible();

  await budget.click({ button: 'right' });
  for (const name of [
    'Open',
    'Manage',
    'Pin to dock',
    'Continue with the Agent',
  ])
    await expect.element(screen.getByRole('menuitem', { name })).toBeVisible();
  await expect
    .element(screen.getByRole('menuitem', { name: /Pin to desk/ }))
    .toBeDisabled();
  await screen.getByRole('menuitem', { name: 'Pin to dock' }).click();
  await vi.waitFor(() =>
    expect(fixtures.pinCalls).toEqual([{ appId: 'app-1', pinned: true }]),
  );
  expect(path()).toBe('/apps');

  // The same menu from the keyboard, on any platform.
  budget.element().focus();
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  await expect
    .element(screen.getByRole('menuitem', { name: 'Remove from dock' }))
    .toBeVisible();
  await screen.getByRole('menuitem', { name: 'Manage' }).click();
  await vi.waitFor(() => expect(path()).toBe('/app/budget-buddy/manage'));
});
