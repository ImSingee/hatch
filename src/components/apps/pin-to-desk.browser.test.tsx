import { MantineProvider } from '@mantine/core';
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
  const [{ usePinToDesk }, { rememberDashboard }] = await Promise.all([
    import('./pin-to-desk'),
    import('~components/desk/last-dashboard'),
  ]);
  // The person last looked at the Weekend desk.
  rememberDashboard('weekend');
  function Harness() {
    const { control, reason } = usePinToDesk(appId);
    return (
      <>
        {control}
        {reason ? <p>{reason}</p> : null}
      </>
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
  const button = screen.getByRole('button', { name: 'Pin to desk' });
  await expect.element(button).toBeEnabled();
  await button.click();
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
    .element(screen.getByRole('button', { name: 'Pin to desk' }))
    .toBeDisabled();
});

test('an App without a widget says why it cannot be pinned', async () => {
  fixtures.available = [{ appId: 'other', widgetId: 'x', name: 'Other' }];
  const screen = await renderPinToDesk('notes');
  await expect
    .element(screen.getByText('This App has no widget to put on the desk.'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Pin to desk' }))
    .toBeDisabled();
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
    .element(screen.getByRole('button', { name: 'Pin to desk' }))
    .toBeDisabled();
});
