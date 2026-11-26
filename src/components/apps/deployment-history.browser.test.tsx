import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { appCompatibility } from '~/app-compatibility';
import type { DeploymentSummary } from '~server/apps/manage';
import { DeploymentHistory } from './deployment-history';

const fixtures = vi.hoisted(() => ({
  list: vi.fn<() => Promise<DeploymentSummary[]>>(),
  redeploy: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  useRouter: () => ({ invalidate: async () => {} }),
}));

vi.mock('~queries/apps', () => ({
  deploymentsQueryOptions: (id: string) => ({
    queryKey: ['test-deployments', id],
    queryFn: fixtures.list,
  }),
  deploymentRequestsQueryOptions: (id: string) => ({
    queryKey: ['test-requests', id],
    queryFn: async () => ({ builderEnabled: true, requests: [] }),
  }),
  deploymentBuildLogQueryOptions: (id: string, deploymentId: string) => ({
    queryKey: ['test-log', id, deploymentId],
    queryFn: async () => '',
  }),
  appOpsQueryOptions: (id: string) => ({ queryKey: ['test-ops', id] }),
  normalizedManifestQueryOptions: (id: string) => ({
    queryKey: ['test-manifest', id],
  }),
}));

vi.mock('~server/apps', () => ({
  redeployAppFn: fixtures.redeploy,
  rollbackAppFn: () => {
    throw new Error('Unexpected server function call.');
  },
}));

function version(
  number: number,
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary {
  return {
    id: `deployment-${number}`,
    version: number,
    status: 'deployed',
    message: `Release ${number}`,
    error: null,
    createdAt: new Date(2026, 10, number).toISOString(),
    isCurrent: false,
    canRollback: true,
    rollbackBlockedReason: null,
    rollbackBlockedCode: null,
    sourceCommit: String(number).repeat(40),
    sourceOnMaster: true,
    sourceTag: `deploy/v${number}`,
    hasArtifact: true,
    hasBuildLog: false,
    dataSchemaMismatch: false,
    compatibility: appCompatibility(2),
    ...overrides,
  } as DeploymentSummary;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('a refused redeploy reloads the history, so the stale action disappears', async () => {
  // This page last saw v3 on master; a restore elsewhere has since moved
  // master back to v2.
  fixtures.list
    .mockResolvedValueOnce([version(3), version(2, { isCurrent: true })])
    .mockResolvedValue([
      version(3, { sourceOnMaster: false }),
      version(2, { isCurrent: true }),
    ]);
  fixtures.redeploy.mockRejectedValue(
    Object.assign(new Error('Cannot deploy: not on master.'), {
      code: 'deployments.commitNotOnMaster',
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <DeploymentHistory appId="app-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );

  const redeploy = page.getByRole('button', { name: 'Redeploy' });
  await expect.poll(() => redeploy.all().length).toBe(2);
  await redeploy.first().click();

  await expect.poll(() => fixtures.redeploy.mock.calls.length).toBe(1);
  await expect.poll(() => fixtures.list.mock.calls.length).toBe(2);
  // Only the version still on master offers Redeploy now.
  await expect.poll(() => redeploy.all().length).toBe(1);
});
