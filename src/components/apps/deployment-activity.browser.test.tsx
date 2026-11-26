import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppDeploymentRequestView } from '~server/apps';
import { DeploymentActivity } from './deployment-activity';

const fixtures = vi.hoisted(() => ({
  requests: vi.fn<
    () => Promise<{
      builderEnabled: boolean;
      deployments: AppDeploymentRequestView[];
    }>
  >(),
  toast: vi.fn<(message: string) => void>(),
}));

vi.mock('sonner', () => ({
  toast: { success: fixtures.toast, error: fixtures.toast },
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: async () => {} }),
}));

vi.mock('~queries/apps', () => ({
  deploymentRequestsQueryOptions: (id: string) => ({
    queryKey: ['test-requests', id],
    queryFn: fixtures.requests,
  }),
  deploymentRequestLogQueryOptions: (id: string, deploymentId: string) => ({
    queryKey: ['test-log', id, deploymentId],
    queryFn: async () => ({ deployment: null, lines: [], complete: true }),
  }),
  deploymentsQueryOptions: (id: string) => ({
    queryKey: ['test-deployments', id],
  }),
  appOpsQueryOptions: (id: string) => ({ queryKey: ['test-ops', id] }),
  normalizedManifestQueryOptions: (id: string) => ({
    queryKey: ['test-manifest', id],
  }),
}));

vi.mock('~server/apps', () => ({
  cancelAppDeploymentFn: () => {
    throw new Error('Unexpected server function call.');
  },
}));

function request(
  overrides: Partial<AppDeploymentRequestView>,
): AppDeploymentRequestView {
  return {
    id: 'request-1',
    seq: 1,
    commit: 'a'.repeat(40),
    message: 'Release',
    build: 'builder',
    trigger: 'cli',
    status: 'ready',
    finished: true,
    errorCode: null,
    errorMessage: null,
    version: 4,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  } as AppDeploymentRequestView;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('a release in the first snapshot refreshes the page without a toast', async () => {
  // The version history loaded while this deployment was still releasing;
  // the first request snapshot already shows it ready.
  fixtures.requests.mockResolvedValue({
    builderEnabled: true,
    deployments: [request({ status: 'ready' })],
  });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <DeploymentActivity appId="app-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );

  await expect
    .poll(() =>
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(['test-deployments', 'app-1']),
      ),
    )
    .toBe(true);
  expect(fixtures.toast).not.toHaveBeenCalled();
});
