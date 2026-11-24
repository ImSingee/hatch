import { MantineProvider, Menu } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const fixtures = vi.hoisted(() => ({
  available: [] as { appId: string; widgetId: string; name: string }[],
  placed: {} as Record<string, { appId: string; widgetId: string }[]>,
  dashboardsFail: false,
  added: [] as unknown[],
}));

vi.mock('~queries/dashboards', () => ({
  dashboardsQueryOptions: {
    queryKey: ['test-dashboards'],
    queryFn: async () => {
      if (fixtures.dashboardsFail) throw new Error('Dashboards unavailable');
      return [
        { id: 'home', name: 'My Dashboard' },
        { id: 'weekend', name: 'Weekend' },
      ];
    },
  },
  availableWidgetsQueryOptions: {
    queryKey: ['test-available'],
    queryFn: async () => fixtures.available,
  },
  dashboardQueryOptions: (id: string) => ({
    queryKey: ['dashboard', 'widgets', id],
    queryFn: async () => ({ widgets: fixtures.placed[id] ?? [] }),
  }),
}));
vi.mock('~server/dashboards', () => ({
  addDashboardWidget: async (input: { data: unknown }) => {
    fixtures.added.push(input.data);
    return { placementId: 'p1' };
  },
}));

async function renderPinToDesk(appId: string) {
  const [{ PinToDeskItems }, { rememberDashboard }] = await Promise.all([
    import('./pin-to-desk'),
    import('~components/desk/last-dashboard'),
  ]);
  // The person last looked at the Weekend desk.
  rememberDashboard('weekend');
  // The items as the All apps right-click menu shows them.
  function Harness() {
    return (
      <Menu opened>
        <Menu.Target>
          <button type="button">Menu</button>
        </Menu.Target>
        <Menu.Dropdown>
          <PinToDeskItems appId={appId} />
        </Menu.Dropdown>
      </Menu>
    );
  }
  return render(
    <MantineProvider>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

beforeEach(() => {
  fixtures.available = [];
  fixtures.placed = {};
  fixtures.added = [];
  fixtures.dashboardsFail = false;
});

test('pin to desk places the widget on the desk shown last', async () => {
  fixtures.available = [{ appId: 'notes', widgetId: 'today', name: 'Today' }];
  // Already on another desk does not count.
  fixtures.placed = { home: [{ appId: 'notes', widgetId: 'today' }] };
  const screen = await renderPinToDesk('notes');
  const item = screen.getByRole('menuitem', { name: /^Pin to desk/ });
  await expect.element(item).toBeEnabled();
  await item.click();
  await vi.waitFor(() =>
    expect(fixtures.added).toEqual([
      { dashboardId: 'weekend', appId: 'notes', widgetId: 'today' },
    ]),
  );
});

test('a widget already on that desk is not added twice', async () => {
  fixtures.available = [{ appId: 'notes', widgetId: 'today', name: 'Today' }];
  fixtures.placed = { weekend: [{ appId: 'notes', widgetId: 'today' }] };
  const screen = await renderPinToDesk('notes');
  await expect.element(screen.getByText('Already on Weekend.')).toBeVisible();
  await expect
    .element(screen.getByRole('menuitem', { name: /^Pin to desk/ }))
    .toBeDisabled();
});

test('an App without a widget says why it cannot be pinned', async () => {
  fixtures.available = [{ appId: 'other', widgetId: 'x', name: 'Other' }];
  const screen = await renderPinToDesk('notes');
  await expect
    .element(screen.getByText('This App has no widget to put on the desk.'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('menuitem', { name: /^Pin to desk/ }))
    .toBeDisabled();
});

test('an App with several widgets offers each one that is not on the desk yet', async () => {
  fixtures.available = [
    { appId: 'notes', widgetId: 'today', name: 'Today' },
    { appId: 'notes', widgetId: 'streak', name: 'Streak' },
    { appId: 'notes', widgetId: 'goals', name: 'Goals' },
  ];
  fixtures.placed = { weekend: [{ appId: 'notes', widgetId: 'goals' }] };
  const screen = await renderPinToDesk('notes');
  await screen.getByRole('menuitem', { name: /^Pin to desk/ }).hover();
  await expect.element(screen.getByText('Add to Weekend')).toBeVisible();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Goals' }))
    .not.toBeInTheDocument();
  await screen.getByRole('menuitem', { name: 'Streak' }).click();
  await vi.waitFor(() =>
    expect(fixtures.added).toEqual([
      { dashboardId: 'weekend', appId: 'notes', widgetId: 'streak' },
    ]),
  );
});

test('an App with several widgets waits for the dashboards before the menu', async () => {
  fixtures.available = [
    { appId: 'notes', widgetId: 'today', name: 'Today' },
    { appId: 'notes', widgetId: 'streak', name: 'Streak' },
  ];
  fixtures.dashboardsFail = true;
  const screen = await renderPinToDesk('notes');
  // Widgets are known but no dashboard is: no crash, the button stays off.
  await expect
    .element(screen.getByRole('menuitem', { name: /^Pin to desk/ }))
    .toBeDisabled();
});
