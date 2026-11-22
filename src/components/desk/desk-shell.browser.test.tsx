import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';

type Pin = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  entryHash: string | null;
};

const fixtures = vi.hoisted(() => ({
  pins: [] as Pin[],
  workflows: [] as {
    id: string;
    slug: string;
    name: string;
    pinned: boolean;
    status?: string;
  }[],
  runnerState: 'connected' as string,
  apps: [] as {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    capabilities: { frontend: boolean } | null;
  }[],
}));

vi.mock('~queries/agent', () => ({
  agentRunnerStatusQueryOptions: {
    queryKey: ['test-runner-status'],
    queryFn: async () => ({ state: fixtures.runnerState, runners: [] }),
  },
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: {
    queryKey: ['test-apps'],
    queryFn: async () => fixtures.apps,
  },
  normalizedManifestQueryOptions: (appId: string) => ({
    queryKey: ['test-app-manifest', appId],
    queryFn: async () => ({ app: { routes: [] } }),
  }),
}));
vi.mock('~queries/sidebar', () => ({
  sidebarItemsQueryOptions: {
    queryKey: ['test-pins'],
    queryFn: async () => fixtures.pins,
  },
}));
vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => fixtures.workflows,
  },
}));
vi.mock('~server/sidebar', () => ({
  addSidebarItem: async () => undefined,
  removeSidebarItem: async () => undefined,
  reorderSidebarItems: async () => undefined,
  setSidebarPin: async () => undefined,
  updateSidebarItem: async () => undefined,
}));
vi.mock('~server/workflows', () => ({
  setWorkflowPinFn: async () => undefined,
}));
vi.mock('~auth/client', () => ({
  authClient: {
    signOut: async () => ({}),
    useSession: () => ({
      data: { user: { name: 'Test owner', email: 'owner@example.test' } },
    }),
  },
}));
vi.mock('~components/apps/use-app-icon', () => ({
  appIconUrl: () => '',
  useAppIconKey: () => null,
  useHasAppIcons: () => false,
}));

/** The real shell around stand-in pages, each in a real window. */
async function renderDesk(initialEntry: string) {
  const [{ DeskShell }, { DeskWindow }, { DeskHome }] = await Promise.all([
    import('./desk-shell'),
    import('./window'),
    import('./desk-home'),
  ]);

  // Mirrors `src/routes/_app.tsx`: view and dock markers come from the URL.
  function Shell() {
    const route = useRouterState({ select: (s) => s.location.hash });
    const { dashboardId, appSlug, workflowSlug } = useParams({
      strict: false,
    }) as Record<string, string | undefined>;
    return (
      <DeskShell
        view={dashboardId ? 'home' : 'window'}
        tabDestination={false}
        openItems={
          appSlug
            ? [{ kind: 'app', slug: appSlug, route }]
            : workflowSlug
              ? [{ kind: 'workflow', slug: workflowSlug }]
              : []
        }
      >
        <Outlet />
      </DeskShell>
    );
  }

  const rootRoute = createRootRoute({ component: Shell });
  const page = (path: string, title: string, closeTo?: string) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => (
        <DeskWindow
          title={title}
          closeTo={
            closeTo
              ? { link: { to: closeTo } as never, label: 'All apps' }
              : undefined
          }
        >
          <label>
            Note
            <input />
          </label>
        </DeskWindow>
      ),
    });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/dashboard',
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/dashboard/$dashboardId',
        component: () => <DeskHome title="My desk">Widgets</DeskHome>,
      }),
      page('/agent', 'Agent'),
      page('/apps', 'Apps'),
      page('/app/$appSlug', 'Running app'),
      page('/app/$appSlug/manage', 'Manage app', '/apps'),
      page('/workflow/$workflowSlug', 'Workflow'),
      page('/workflow/$workflowSlug/manage', 'Manage workflow'),
      page('/workflows', 'Workflows'),
      page('/notifications', 'Notifications'),
      page('/dashboards', 'Dashboards'),
      page('/settings', 'Settings'),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  const path = () => router.state.location.pathname;
  return { router, screen, path, queryClient };
}

beforeEach(() => {
  fixtures.pins = [];
  fixtures.workflows = [];
  fixtures.apps = [];
  fixtures.runnerState = 'connected';
});

test('every destination of the shell is reachable from the menu bar', async () => {
  const { screen, path } = await renderDesk('/dashboard/home');
  const primary = screen.getByRole('navigation', { name: 'Primary' });

  await expect
    .element(primary.getByRole('link', { name: 'Desk' }))
    .toHaveAttribute('aria-current', 'page');

  await primary.getByRole('link', { name: 'Agent' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Agent' }))
    .toBeVisible();

  await primary.getByRole('link', { name: 'All apps' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Apps' }))
    .toBeVisible();

  await screen.getByRole('link', { name: 'Notifications' }).click();
  await vi.waitFor(() => expect(path()).toBe('/notifications'));

  for (const [item, target] of [
    ['Dashboards', '/dashboards'],
    ['Workflows', '/workflows'],
    ['Settings', '/settings'],
  ]) {
    await screen.getByRole('button', { name: 'Account menu' }).click();
    await screen.getByRole('menuitem', { name: item }).click();
    await vi.waitFor(() => expect(path()).toBe(target));
  }

  await screen.getByRole('button', { name: 'Account menu' }).click();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Sign out' }))
    .toBeVisible();
});

test('a deep link opens its window, and closing returns to the desk', async () => {
  const { router, screen, path } = await renderDesk('/workflows');

  await expect
    .element(screen.getByRole('heading', { name: 'Workflows' }))
    .toBeVisible();
  // Opening a window moves keyboard focus into it.
  expect(document.activeElement).toBe(
    screen.getByRole('region', { name: 'Workflows' }).element(),
  );

  await screen.getByRole('link', { name: /^Close window/ }).click();
  await vi.waitFor(() => expect(path()).toBe('/dashboard'));

  // The window is still one step back in history.
  router.history.back();
  await expect
    .element(screen.getByRole('heading', { name: 'Workflows' }))
    .toBeVisible();

  await screen.getByRole('link', { name: /^Minimise window/ }).click();
  await vi.waitFor(() => expect(path()).toBe('/dashboard'));
});

test('close leads to the parent a window names; minimise to the desk', async () => {
  const { router, screen, path } = await renderDesk('/app/todo/manage');

  await screen
    .getByRole('link', { name: 'Close window, back to All apps' })
    .click();
  await vi.waitFor(() => expect(path()).toBe('/apps'));

  await router.navigate({ to: '/app/todo/manage' as never });
  await screen.getByRole('link', { name: /^Minimise window/ }).click();
  await vi.waitFor(() => expect(path()).toBe('/dashboard'));
});

test('Escape closes the window unless a field or a menu owns the key', async () => {
  const { screen, path } = await renderDesk('/settings');
  await expect
    .element(screen.getByRole('heading', { name: 'Settings' }))
    .toBeVisible();

  await screen.getByRole('textbox', { name: 'Note' }).click();
  await userEvent.keyboard('{Escape}');
  await screen.getByRole('button', { name: 'Account menu' }).click();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Sign out' }))
    .toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect
    .element(screen.getByRole('menuitem', { name: 'Sign out' }))
    .not.toBeInTheDocument();
  expect(path()).toBe('/settings');

  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(path()).toBe('/dashboard'));
});

test('the dock lists pins and marks the one whose window is open', async () => {
  fixtures.pins = [
    {
      id: 'pin-root',
      appId: 'app-1',
      appSlug: 'todo',
      label: 'Todo home',
      entryHash: null,
    },
    {
      id: 'pin-settings',
      appId: 'app-1',
      appSlug: 'todo',
      label: 'Todo settings',
      entryHash: 'settings',
    },
    {
      id: 'pin-notes',
      appId: 'app-2',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  fixtures.workflows = [
    { id: 'wf-1', slug: 'daily-digest', name: 'Daily digest', pinned: true },
    { id: 'wf-2', slug: 'unpinned', name: 'Not pinned', pinned: false },
  ];

  const { router, screen } = await renderDesk('/app/todo#settings');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  const home = dock.getByRole('link', { name: 'Todo home' });
  const settings = dock.getByRole('link', { name: 'Todo settings' });
  const notes = dock.getByRole('link', { name: 'Notes' });
  const digest = dock.getByRole('link', { name: 'Daily digest' });

  await expect.element(home).toHaveAttribute('href', '/app/todo');
  await expect.element(settings).toHaveAttribute('href', '/app/todo#settings');
  await expect
    .element(digest)
    .toHaveAttribute('href', '/workflow/daily-digest');
  await expect
    .element(dock.getByRole('link', { name: 'Not pinned' }))
    .not.toBeInTheDocument();

  // An App pinned twice marks only the pin whose entry point is open.
  await expect.element(settings).toHaveAttribute('data-open', 'true');
  await expect.element(home).not.toHaveAttribute('data-open');
  await expect.element(notes).not.toHaveAttribute('data-open');

  // A hash router's home is '/', which is the root pin.
  await router.navigate({ to: '/app/$appSlug' as never, hash: '/' } as never);
  await expect.element(home).toHaveAttribute('data-open', 'true');
  await expect.element(settings).not.toHaveAttribute('data-open');

  await digest.click();
  await expect.element(digest).toHaveAttribute('data-open', 'true');
  await expect.element(home).not.toHaveAttribute('data-open');

  // Manage stays reachable from a pin's own menu.
  await dock.getByRole('button', { name: 'Notes options' }).click();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Manage' }))
    .toHaveAttribute('href', '/app/notes/manage');
});

test('the menu bar warns only while the runner is offline, and ⌘K searches', async () => {
  fixtures.apps = [
    {
      id: 'app-1',
      slug: 'water-log',
      name: 'Water Log',
      description: null,
      status: 'deployed',
      capabilities: { frontend: true },
    },
  ];
  fixtures.workflows = [
    {
      id: 'wf-1',
      slug: 'morning-digest',
      name: 'Morning Digest',
      pinned: false,
    },
  ];
  const { screen, path } = await renderDesk('/dashboard/home');

  // A connected runner needs no attention.
  await expect
    .element(screen.getByRole('link', { name: /Runner offline/ }))
    .not.toBeInTheDocument();

  await userEvent.keyboard('{Control>}k{/Control}');
  const search = screen.getByRole('textbox', {
    name: 'Search apps, workflows and pages',
  });
  await expect.element(search).toBeVisible();
  await userEvent.type(search, 'morning');
  await screen.getByRole('button', { name: 'Morning Digest' }).click();
  await vi.waitFor(() => expect(path()).toBe('/workflow/morning-digest'));

  await screen
    .getByRole('button', { name: 'Search apps, workflows and pages' })
    .click();
  await userEvent.fill(search, 'water');
  await screen.getByRole('button', { name: 'Water Log' }).click();
  await vi.waitFor(() => expect(path()).toBe('/app/water-log'));
});

test('a pin removed elsewhere turns its open edit dialog into a notice', async () => {
  fixtures.pins = [
    {
      id: 'pin-notes',
      appId: 'app-2',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  const { screen, queryClient } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  await dock.getByRole('button', { name: 'Notes options' }).click();
  await screen.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = screen.getByRole('dialog', { name: 'Edit pin' });
  await expect
    .element(dialog.getByRole('textbox', { name: 'Name' }))
    .toHaveValue('Notes');

  // What a pins.updated event does: the live pins no longer hold it.
  fixtures.pins = [];
  await queryClient.invalidateQueries({ queryKey: ['test-pins'] });
  await expect
    .element(dialog.getByText(/This pin was removed from the dock elsewhere/))
    .toBeVisible();
  await expect
    .element(dialog.getByRole('button', { name: 'Save' }))
    .not.toBeInTheDocument();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect.element(dialog).not.toBeInTheDocument();
});

test('an offline runner shows a warning that leads to its status', async () => {
  fixtures.runnerState = 'offline';
  const { screen } = await renderDesk('/dashboard/home');
  await expect
    .element(screen.getByRole('link', { name: /Runner offline/ }))
    .toHaveAttribute('href', '/settings/agent-runner');
});
