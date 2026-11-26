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
import { page, userEvent } from 'vitest/browser';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';

type Pin = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  entryHash: string | null;
};

const fixtures = vi.hoisted(() => ({
  pins: [] as Pin[],
  runnerState: 'connected' as string,
  dockLabels: false,
  unread: 0,
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
// The windows of running Apps read their deployment; these tests run none.
vi.mock('~server/apps', () => ({
  getAppDeploymentRevision: async () => null,
}));
vi.mock('~queries/sidebar', () => ({
  sidebarItemsQueryOptions: {
    queryKey: ['test-pins'],
    queryFn: async () => fixtures.pins,
  },
}));
vi.mock('~queries/theme', () => ({
  themeQueryOptions: {
    queryKey: ['test-theme'],
    queryFn: async () => ({
      accent: 'indigo',
      dockLabels: fixtures.dockLabels,
    }),
  },
}));
vi.mock('~server/sidebar', () => ({
  addSidebarItem: async () => undefined,
  removeSidebarItem: async () => undefined,
  reorderSidebarItems: async () => undefined,
  setSidebarPin: async () => undefined,
  updateSidebarItem: async () => undefined,
}));
vi.mock('~auth/client', () => ({
  authClient: {
    signOut: async () => ({}),
    useSession: () => ({
      data: { user: { name: 'Test owner', email: 'owner@example.test' } },
    }),
  },
}));
vi.mock('~components/notifications/use-notification-read-state', () => ({
  useNotificationReadState: () => ({
    data: { unreadCount: fixtures.unread },
  }),
}));
vi.mock('~components/apps/use-app-icon', () => ({
  appIconUrl: () => '',
  useAppIconKey: () => null,
  useHasAppIcons: () => false,
}));

/** The real shell around stand-in pages, each in a real window. */
async function renderDesk(initialEntry: string) {
  const [{ DeskShell }, { DeskWindow }, { DeskHome }, { AppSessionsProvider }] =
    await Promise.all([
      import('./desk-shell'),
      import('./window'),
      import('./desk-home'),
      import('./app-sessions'),
    ]);

  // Mirrors `src/routes/_app.tsx`: view and dock markers come from the URL.
  function Shell() {
    const route = useRouterState({ select: (s) => s.location.hash });
    const { dashboardId, appSlug } = useParams({
      strict: false,
    }) as Record<string, string | undefined>;
    return (
      <AppSessionsProvider>
        <DeskShell
          view={dashboardId ? 'home' : 'window'}
          tabDestination={false}
          openItems={appSlug ? [{ kind: 'app', slug: appSlug, route }] : []}
        >
          <Outlet />
        </DeskShell>
      </AppSessionsProvider>
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
    // The Desk theme and its variables, so sizes such as the dock tile are
    // the ones users get.
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  const path = () => router.state.location.pathname;
  return { router, screen, path, queryClient };
}

/**
 * With a mouse the dock waits below the bottom edge, marked by a short bar;
 * point at the bar the way a person would to bring it up.
 */
async function revealDock() {
  const handle = document.querySelector<HTMLElement>('[class*="dockHandle"]');
  if (!handle) throw new Error('The waiting dock shows no handle');
  await userEvent.hover(page.elementLocator(handle));
}

/** Whether the dock is on screen: its bottom is inside the viewport. */
function dockShown() {
  const nav = document.querySelector('nav[aria-label="Dock"]');
  return Boolean(
    nav && nav.getBoundingClientRect().bottom <= window.innerHeight,
  );
}

beforeEach(() => {
  fixtures.pins = [];
  fixtures.apps = [];
  fixtures.runnerState = 'connected';
  fixtures.dockLabels = false;
  fixtures.unread = 0;
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
  const { router, screen, path } = await renderDesk('/dashboards');

  await expect
    .element(screen.getByRole('heading', { name: 'Dashboards' }))
    .toBeVisible();
  // Opening a window moves keyboard focus into it.
  expect(document.activeElement).toBe(
    screen.getByRole('region', { name: 'Dashboards' }).element(),
  );

  await screen.getByRole('link', { name: /^Close window/ }).click();
  await vi.waitFor(() => expect(path()).toBe('/dashboard'));

  // The window is still one step back in history.
  router.history.back();
  await expect
    .element(screen.getByRole('heading', { name: 'Dashboards' }))
    .toBeVisible();
});

test('close leads to the parent a window names; minimise is not available yet', async () => {
  const { router, screen, path } = await renderDesk('/app/todo/manage');

  await screen
    .getByRole('link', { name: 'Close window, back to All apps' })
    .click();
  await vi.waitFor(() => expect(path()).toBe('/apps'));

  await router.navigate({ to: '/app/todo/manage' as never });
  await expect
    .element(screen.getByRole('button', { name: 'Minimise window' }))
    .toBeDisabled();
  expect(path()).toBe('/app/todo/manage');
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

  const { router, screen } = await renderDesk('/app/todo#settings');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  const home = dock.getByRole('link', { name: 'Todo home' });
  const settings = dock.getByRole('link', { name: 'Todo settings' });
  const notes = dock.getByRole('link', { name: 'Notes' });

  await expect.element(home).toHaveAttribute('href', '/app/todo');
  await expect.element(settings).toHaveAttribute('href', '/app/todo#settings');
  await expect.element(notes).toHaveAttribute('href', '/app/notes');

  // An App pinned twice marks only the pin whose entry point is open.
  await expect.element(settings).toHaveAttribute('data-open', 'true');
  await expect.element(home).not.toHaveAttribute('data-open');
  await expect.element(notes).not.toHaveAttribute('data-open');

  // A hash router's home is '/', which is the root pin.
  await router.navigate({ to: '/app/$appSlug' as never, hash: '/' } as never);
  await expect.element(home).toHaveAttribute('data-open', 'true');
  await expect.element(settings).not.toHaveAttribute('data-open');

  // An App pinned once is marked wherever that App is open.
  await revealDock();
  await notes.click();
  await expect.element(notes).toHaveAttribute('data-open', 'true');
  await expect.element(home).not.toHaveAttribute('data-open');

  // A pin's own actions are in the dock's right-click menu.
  await notes.click({ button: 'right' });
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
  const { screen, path } = await renderDesk('/dashboard/home');

  // A connected runner needs no attention.
  await expect
    .element(screen.getByRole('link', { name: /Runner offline/ }))
    .not.toBeInTheDocument();

  const mod = /mac/i.test(navigator.platform) ? 'Meta' : 'Control';
  await userEvent.keyboard(`{${mod}>}k{/${mod}}`);
  const search = screen.getByRole('textbox', {
    name: 'Search apps and pages',
  });
  await expect.element(search).toBeVisible();
  await userEvent.type(search, 'water');
  await screen.getByRole('button', { name: 'Water Log' }).click();
  await vi.waitFor(() => expect(path()).toBe('/app/water-log'));

  // The menu bar's search button opens the same palette, which finds places.
  await screen.getByRole('button', { name: 'Search apps and pages' }).click();
  await userEvent.fill(search, 'dashb');
  await screen.getByRole('button', { name: 'Dashboards' }).click();
  await vi.waitFor(() => expect(path()).toBe('/dashboards'));
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
  await revealDock();
  await dock.getByRole('link', { name: 'Notes' }).click({ button: 'right' });
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

test('many pinned apps scroll inside the dock instead of overflowing it', async () => {
  await page.viewport(600, 800);
  fixtures.pins = Array.from({ length: 10 }, (_, index) => ({
    id: `pin-${index}`,
    appId: `app-${index}`,
    appSlug: `digest-${index}`,
    label: `Digest ${index}`,
    entryHash: null,
  }));
  const { screen } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  await expect
    .element(dock.getByRole('link', { name: 'Digest 0' }))
    .toBeInTheDocument();
  const last = dock.getByRole('link', { name: 'Digest 9' });
  await vi.waitFor(() => {
    const dockBox = dock.element().getBoundingClientRect();
    const row = last.element().closest<HTMLElement>('[class*="row"]')!;
    // The pins stay inside the dock, and their row scrolls.
    expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(
      dockBox.right + 1,
    );
    expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
  });
});

test('the dock waits below the edge, rises at it, and stays while its menu is open', async () => {
  fixtures.pins = [
    {
      id: 'pin-notes',
      appId: 'app-2',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  fixtures.apps = [
    {
      id: 'app-9',
      slug: 'daily-digest',
      name: 'Daily digest',
      description: null,
      status: 'deployed',
      capabilities: { frontend: true },
    },
  ];
  const { screen } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  await expect
    .element(dock.getByRole('link', { name: 'Notes' }))
    .toBeInTheDocument();

  // It takes no room: the page runs to the bottom while the dock waits.
  await userEvent.hover(screen.getByRole('heading', { name: 'Apps' }));
  await vi.waitFor(() => expect(dockShown()).toBe(false));

  await revealDock();
  await vi.waitFor(() => expect(dockShown()).toBe(true));

  // Adding lives in the right-click menu, which keeps the dock up while the
  // pointer is in it.
  await dock.getByRole('link', { name: 'Notes' }).click({ button: 'right' });
  const addApp = screen.getByRole('menuitem', { name: 'Add an app' });
  await addApp.hover();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Daily digest' }))
    .toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(dockShown()).toBe(true);
  await expect
    .element(screen.getByRole('menuitem', { name: 'Unpin' }))
    .toBeVisible();

  await userEvent.keyboard('{Escape}');
  await userEvent.keyboard('{Escape}');
  await userEvent.hover(screen.getByRole('heading', { name: 'Apps' }));
  await vi.waitFor(() => expect(dockShown()).toBe(false));
});

test('an empty dock shows only its add tile; pins end with All apps', async () => {
  const { screen, queryClient } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });

  await expect
    .element(dock.getByRole('button', { name: 'Add app' }))
    .toBeInTheDocument();
  expect(dock.getByRole('link').elements()).toEqual([]);

  fixtures.pins = [
    {
      id: 'pin-notes',
      appId: 'app-2',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  await queryClient.invalidateQueries();
  await expect
    .element(dock.getByRole('link', { name: 'All apps' }))
    .toHaveAttribute('href', '/apps');
  await expect
    .element(dock.getByRole('button', { name: 'Add app' }))
    .not.toBeInTheDocument();
  const links = dock.getByRole('link').elements();
  expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
    'Notes',
    'All apps',
  ]);
});

test('names stay out of the dock unless the instance shows them, and pointing at a tile shows its full name', async () => {
  fixtures.pins = [
    {
      id: 'pin-ledger',
      appId: 'app-3',
      appSlug: 'ledger',
      label: 'Household ledger for the shared flat',
      entryHash: null,
    },
  ];
  const { screen, queryClient } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  const ledger = dock.getByRole('link', {
    name: 'Household ledger for the shared flat',
  });
  await expect.element(ledger).toBeInTheDocument();
  const printed = () =>
    [...dock.element().querySelectorAll('[class*="_label_"]')].filter(
      (label) => getComputedStyle(label).display !== 'none',
    ).length;
  expect(printed()).toBe(0);

  await revealDock();
  await ledger.hover();
  await expect
    .element(
      screen.getByRole('tooltip', {
        name: 'Household ledger for the shared flat',
      }),
    )
    .toBeVisible();

  fixtures.dockLabels = true;
  await queryClient.invalidateQueries({ queryKey: ['test-theme'] });
  await vi.waitFor(() => expect(printed()).toBeGreaterThan(0));
});

test('keyboard focus shows a tile its full name and Shift+F10 its actions, and so does a long press', async () => {
  fixtures.pins = [
    {
      id: 'pin-ledger',
      appId: 'app-3',
      appSlug: 'ledger',
      label: 'Household ledger',
      entryHash: null,
    },
  ];
  const { screen } = await renderDesk('/apps');
  const dock = screen.getByRole('navigation', { name: 'Dock' });
  const ledger = dock.getByRole('link', { name: 'Household ledger' });
  await expect.element(ledger).toBeInTheDocument();

  // Tab into the dock from the page.
  await userEvent.hover(screen.getByRole('heading', { name: 'Apps' }));
  let focused = false;
  for (let step = 0; step < 40 && !focused; step++) {
    await userEvent.keyboard('{Tab}');
    focused = document.activeElement === ledger.element();
  }
  expect(focused).toBe(true);
  await expect
    .element(screen.getByRole('tooltip', { name: 'Household ledger' }))
    .toBeVisible();
  // Shift+F10 opens the tile's right-click menu, on every platform.
  await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  await vi.waitFor(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain(
      'Unpin',
    ),
  );
  await userEvent.keyboard('{Escape}');
  (document.activeElement as HTMLElement).blur();

  // A long press: touches without a contextmenu event, as iOS Safari sends.
  const target = ledger.element();
  const box = target.getBoundingClientRect();
  const touch = new Touch({
    identifier: 1,
    target,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  const press = (type: 'touchstart' | 'touchend') =>
    target.dispatchEvent(
      new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchstart' ? [touch] : [],
        targetTouches: type === 'touchstart' ? [touch] : [],
        changedTouches: [touch],
      }),
    );
  // Hold past the long-press delay: the menu opens on that tile, with its
  // own actions. (This runner has a mouse, so the dock sits in its clipped
  // floating layer and the popover keeps itself hidden; on a touch device
  // the dock has its own row. What the fix changes is the menu's content.)
  press('touchstart');
  await vi.waitFor(() => {
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Household ledger');
    expect(
      [...menu!.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['Edit', 'Unpin', 'Manage', 'Add an app', 'New with Agent']);
  });
  press('touchend');
});

test('a maximized window fills the screen, the menu bar waits at the top edge, and the next window opens the same way', async () => {
  await page.viewport(1280, 800);
  localStorage.removeItem('hatch.desk.windowMaximized');
  const { router, screen } = await renderDesk('/settings');
  const window_ = () => screen.getByRole('region', { name: 'Settings' });
  await expect.element(window_()).toBeVisible();
  const menuBar = () =>
    document.querySelector<HTMLElement>('[class*="menuBar"] > *')!;
  const menuBarShown = () => menuBar().getBoundingClientRect().bottom > 1;

  await screen.getByRole('button', { name: 'Maximize window' }).click();
  await expect.element(window_()).toHaveAttribute('data-maximized', 'true');
  await vi.waitFor(() => {
    const box = window_().element().getBoundingClientRect();
    expect(box.top).toBeLessThanOrEqual(1);
    expect(box.left).toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(window.innerWidth - 1);
  });
  // The menu bar waits above the edge, and comes down at the edge.
  await userEvent.hover(screen.getByRole('heading', { name: 'Settings' }));
  await vi.waitFor(() => expect(menuBarShown()).toBe(false));
  const edge = document.querySelector<HTMLElement>('[class*="menuEdge"]')!;
  await userEvent.hover(page.elementLocator(edge));
  await vi.waitFor(() => expect(menuBarShown()).toBe(true));
  // It floats over the top of the window; the window stays where it is.
  expect(window_().element().getBoundingClientRect().top).toBeLessThanOrEqual(
    1,
  );

  // The next window opens maximized, and restoring brings the bar back.
  await router.navigate({ to: '/apps' as never });
  await expect
    .element(screen.getByRole('region', { name: 'Apps' }))
    .toHaveAttribute('data-maximized', 'true');
  expect(localStorage.getItem('hatch.desk.windowMaximized')).toBe('true');
  // Move into the window so the bar goes up and uncovers its buttons.
  await userEvent.hover(screen.getByRole('textbox', { name: 'Note' }));
  await vi.waitFor(() => expect(menuBarShown()).toBe(false));
  await screen.getByRole('button', { name: 'Restore window' }).click();
  await expect
    .element(screen.getByRole('region', { name: 'Apps' }))
    .not.toHaveAttribute('data-maximized');
  await userEvent.hover(screen.getByRole('heading', { name: 'Apps' }));
  await vi.waitFor(() => expect(menuBarShown()).toBe(true));
  expect(localStorage.getItem('hatch.desk.windowMaximized')).toBeNull();
});

test('the bell says how many notifications are unread', async () => {
  fixtures.unread = 3;
  const { screen } = await renderDesk('/');
  await expect
    .element(screen.getByRole('link', { name: 'Notifications, 3 unread' }))
    .toBeVisible();
});
