import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const events = vi.hoisted(() => ({
  listener: undefined as
    | ((event: { dashboardId?: string }) => void)
    | undefined,
}));

vi.mock('~components/system/platform-events', () => ({
  usePlatformEvent: (_type: string, listener: typeof events.listener) => {
    events.listener = listener;
  },
  usePlatformResync: () => {},
}));
vi.mock('~queries/dashboards', () => ({
  dashboardsQueryOptions: { queryKey: ['dashboards'] },
  dashboardQueryOptions: (id: string) => ({
    queryKey: ['dashboard', 'widgets', id],
  }),
}));

test('a change made while editing is read once editing ends', async () => {
  const { useLiveDashboard } = await import('./use-live-dashboard');
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const refetchedDesk = () =>
    invalidate.mock.calls.filter(
      ([filters]) => filters?.queryKey?.[0] === 'dashboard',
    ).length;
  function Desk({ editing }: { editing: boolean }) {
    useLiveDashboard('home', editing);
    return null;
  }
  const ui = (editing: boolean) => (
    <QueryClientProvider client={queryClient}>
      <Desk editing={editing} />
    </QueryClientProvider>
  );

  const screen = await render(ui(true));
  events.listener?.({ dashboardId: 'home' });
  // The open editor keeps its draft: the desk is not refetched yet.
  expect(refetchedDesk()).toBe(0);

  // Cancel or an unchanged Done: editing ends and the held change is read.
  await screen.rerender(ui(false));
  await vi.waitFor(() => expect(refetchedDesk()).toBe(1));

  // Nothing new arrives: leaving and re-entering edit mode refetches nothing.
  await screen.rerender(ui(true));
  await screen.rerender(ui(false));
  expect(refetchedDesk()).toBe(1);
});
