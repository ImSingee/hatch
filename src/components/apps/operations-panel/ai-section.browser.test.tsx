import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppAiView } from '~server/app-ai';
import { AiSection } from './ai-section';

const view = (budgetUsd: number | null): AppAiView => ({
  appId: 'app-1',
  available: true,
  roles: [],
  budgetUsd,
  monthSpendUsd: 0,
  monthUnpricedCalls: 0,
  monthStart: '2026-11-01T00:00:00.000Z',
  models: { chat: [], image: [] },
});

const mocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<AppAiView>>(),
  setBudget:
    vi.fn<
      (input: { data: { budgetUsd: number | null } }) => Promise<AppAiView>
    >(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn<() => void>() } }));
vi.mock('~queries/app-ai', () => ({
  appAiQueryOptions: (id: string) => ({
    queryKey: ['test-app-ai', id],
    queryFn: mocks.get,
  }),
  appAiUsageQueryOptions: (id: string) => ({
    queryKey: ['test-app-ai-usage', id],
    queryFn: async () => ({ calls: [], nextCursor: null, totals: [] }),
  }),
}));
vi.mock('~server/app-ai', () => ({
  setAppAiBudgetFn: mocks.setBudget,
  setAppAiRoleModelFn: vi.fn<() => Promise<AppAiView>>(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(view(25));
  mocks.setBudget.mockImplementation(async ({ data }) => view(data.budgetUsd));
});

async function renderSection() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <AiSection appId="app-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

test('an unfinished amount sets that budget instead of removing the cap', async () => {
  const screen = await renderSection();
  const input = screen.getByLabelText('Monthly budget');
  await input.fill('10.');
  await screen.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => mocks.setBudget.mock.calls.length).toBe(1);
  expect(mocks.setBudget.mock.calls[0][0].data.budgetUsd).toBe(10);
});

test('only an empty input removes the cap', async () => {
  const screen = await renderSection();
  await screen.getByLabelText('Monthly budget').fill('');
  await screen.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => mocks.setBudget.mock.calls.length).toBe(1);
  expect(mocks.setBudget.mock.calls[0][0].data.budgetUsd).toBeNull();
});
