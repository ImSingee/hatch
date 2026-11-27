import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { BuilderOverview } from '~server/apps';
import { BuilderPanel } from './builder-panel';

const fixtures = vi.hoisted(() => ({
  overview: vi.fn<() => Promise<BuilderOverview>>(),
  cancel: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  },
}));

vi.mock('~queries/apps', () => ({
  builderOverviewQueryOptions: {
    queryKey: ['test-builder-overview'],
    queryFn: fixtures.overview,
  },
  deploymentRequestsQueryOptions: (id: string) => ({
    queryKey: ['test-requests', id],
  }),
}));

vi.mock('~server/apps', () => ({ cancelAppDeploymentFn: fixtures.cancel }));

type Entry = BuilderOverview['queue'][number];

function entry(
  id: string,
  app: string,
  status: Entry['deployment']['status'],
  extra: Partial<Entry> = {},
): Entry {
  return {
    app: { id: `${app}-id`, slug: app, name: app.toUpperCase() },
    queuePosition: null,
    builderId: null,
    deployment: {
      id,
      seq: 1,
      commit: 'c'.repeat(40),
      message: `Release ${id}`,
      build: 'builder',
      trigger: 'cli',
      status,
      finished: false,
      errorCode: null,
      errorMessage: null,
      version: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    },
    ...extra,
  };
}

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <Suspense fallback={null}>
          <BuilderPanel />
        </Suspense>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('a platform without a Builder says to deploy with --local', async () => {
  fixtures.overview.mockResolvedValue({
    status: { configured: false, builders: [] },
    queue: [],
    truncated: false,
  });
  show();
  await expect
    .element(page.getByText('This platform has no dedicated Builder'))
    .toBeVisible();
  await expect
    .element(page.getByText(/hatch app deploy --local/))
    .toBeVisible();
  await expect
    .element(page.getByText('No deployment is waiting or in progress.'))
    .toBeVisible();
});

test('shows each Builder and the queue across Apps, and cancels a queued deployment in the middle', async () => {
  fixtures.overview.mockResolvedValue({
    status: {
      configured: true,
      builders: [
        {
          id: 'builder-1',
          concurrency: 2,
          running: 1,
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
        {
          id: 'builder-old',
          concurrency: 1,
          running: 0,
          lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(),
          online: false,
        },
      ],
    },
    queue: [
      entry('dep-a', 'notes', 'building', { builderId: 'builder-1' }),
      entry('dep-b', 'notes', 'queued', { queuePosition: 1 }),
      entry('dep-c', 'tasks', 'queued', { queuePosition: 2 }),
      entry('dep-d', 'shop', 'verifying'),
    ],
    truncated: false,
  });
  fixtures.cancel.mockResolvedValue({});
  show();

  await expect.element(page.getByText('1 online')).toBeVisible();
  await expect.element(page.getByText('builder-old')).toBeVisible();
  await expect.element(page.getByText('1 of 2')).toBeVisible();
  await expect.element(page.getByText('Building on builder-1')).toBeVisible();
  await expect.element(page.getByText('#2')).toBeVisible();
  // A verifying deployment can no longer be canceled.
  expect(
    page.getByRole('button', { name: 'Cancel the deployment of SHOP' }).all(),
  ).toHaveLength(0);

  await page
    .getByRole('button', { name: 'Cancel the deployment of TASKS' })
    .click();
  await expect.poll(() => fixtures.cancel.mock.calls.length).toBe(1);
  expect(fixtures.cancel).toHaveBeenCalledWith({
    data: { id: 'tasks-id', deploymentId: 'dep-c' },
  });
  // The queue is read again after the cancel.
  await expect.poll(() => fixtures.overview.mock.calls.length).toBe(2);
});

test('warns while the platform has a Builder but none is online', async () => {
  fixtures.overview.mockResolvedValue({
    status: {
      configured: true,
      builders: [
        {
          id: 'builder-1',
          concurrency: 1,
          running: 0,
          lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
          online: false,
        },
      ],
    },
    queue: [],
    truncated: false,
  });
  show();
  await expect.element(page.getByText(/No Builder is online/)).toBeVisible();
  await expect.element(page.getByText('0 online')).toBeVisible();
});
