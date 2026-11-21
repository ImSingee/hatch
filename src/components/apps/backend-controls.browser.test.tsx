import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { AppBackendRuntime } from '~server/apps';
import { BackendControls, BackendStatus } from './backend-controls';

const fixtures = vi.hoisted(() => ({
  stop: vi.fn<
    (input: { data: { id: string; force?: boolean } }) => Promise<unknown>
  >(),
}));

vi.mock('~queries/apps', () => ({
  appBackendsQueryOptions: { queryKey: ['test-app-backends'] },
  appOpsQueryOptions: (id: string) => ({ queryKey: ['test-app-ops', id] }),
}));

vi.mock('~server/apps', () => {
  const notCalled = () => {
    throw new Error('Unexpected server function call.');
  };
  return {
    restartAppBackendFn: notCalled,
    startAppBackendFn: notCalled,
    stopAppBackendFn: fixtures.stop,
  };
});

function runtime(overrides: Partial<AppBackendRuntime>): AppBackendRuntime {
  return {
    state: 'stopped',
    pid: null,
    port: null,
    startedAt: null,
    stoppedAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastError: null,
    restartCount: 0,
    keepAlive: false,
    drainingInstances: 0,
    ...overrides,
  };
}

async function renderControls(value: AppBackendRuntime) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <BackendStatus runtime={value} />
        <BackendControls appId="app-1" runtime={value} />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.stop.mockResolvedValue({});
});

test('stops a running backend gracefully', async () => {
  await renderControls(runtime({ state: 'running', pid: 42 }));

  await page.getByRole('button', { name: 'Stop backend' }).click();

  await expect
    .poll(() => fixtures.stop.mock.calls[0]?.[0])
    .toEqual({ data: { id: 'app-1', force: false } });
});

test('offers a force stop only once draining instances are all that is left', async () => {
  await renderControls(runtime({ drainingInstances: 2 }));

  await expect.element(page.getByText('2 draining')).toBeVisible();
  await page.getByRole('button', { name: 'Force stop backend' }).click();

  await expect
    .poll(() => fixtures.stop.mock.calls[0]?.[0])
    .toEqual({ data: { id: 'app-1', force: true } });
});
