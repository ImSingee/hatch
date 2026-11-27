import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render as renderBare } from 'vitest-browser-react';
import { themeQueryOptions } from '~queries/theme';
import type { WebTheme } from '~server/theme';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import type { PlatformEvent } from '~server/platform-events';
import {
  PlatformEventsProvider,
  usePlatformEvent,
  usePlatformResync,
} from './platform-events';

// Server Functions cannot load in the browser project.
// Answers for whoever the session is now, as the server does.
vi.mock('~server/theme', () => ({
  getThemeFn: async () => ({
    userId: session.get(),
    accent: 'indigo',
    defaultAccent: 'indigo',
    accents: [],
  }),
}));

/** The signed-in user the provider sees; tests switch it like another tab. */
const session = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let userId: string | null = 'owner';
  return {
    get: () => userId,
    set(next: string | null) {
      userId = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('~auth/client', () => ({
  authClient: {
    useSession: () => {
      const userId = useSyncExternalStore(session.subscribe, session.get);
      return { data: userId ? { user: { id: userId } } : null };
    },
  },
}));

let queryClient = new QueryClient();

/** The provider refreshes the theme query, so it needs a query client. */
function render(ui: ReactNode) {
  queryClient = new QueryClient();
  return renderBare(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn<() => void>();

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    FakeEventSource.instances.push(this);
  }

  emit(name: 'platform' | 'resync', data: object = {}) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

function installEventSource() {
  FakeEventSource.instances = [];
  vi.stubGlobal(
    'EventSource',
    FakeEventSource as unknown as typeof EventSource,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  session.set('owner');
});

test('reconnects as the new user and drops the old user’s data when the account changes', async () => {
  installEventSource();
  await render(
    <PlatformEventsProvider>
      <SubscriptionProbe name="probe" />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const first = FakeEventSource.instances[0]!;
  // Pins and dashboards are not keyed by user.
  queryClient.setQueryData(['sidebar', 'items'], ['owner-pin']);
  queryClient.setQueryData(['dashboards'], ['owner-dashboard']);

  // Signed out in another tab: the stream stops and nothing reconnects.
  session.set(null);
  await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
  expect(FakeEventSource.instances).toHaveLength(1);

  // Signed in as someone else: a fresh stream, and none of owner's data.
  session.set('other');
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  await vi.waitFor(() =>
    expect(queryClient.getQueryData(['sidebar', 'items'])).toBeUndefined(),
  );
  expect(queryClient.getQueryData(['dashboards'])).toBeUndefined();

  // The same user coming back keeps the cache.
  // (Asserted below: nothing rendered for "other" showed owner's data.)
  queryClient.setQueryData(['dashboards'], ['other-dashboard']);
  session.set(null);
  await vi.waitFor(() =>
    expect(FakeEventSource.instances[1]!.close).toHaveBeenCalledOnce(),
  );
  session.set('other');
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));
  expect(queryClient.getQueryData(['dashboards'])).toEqual(['other-dashboard']);
});

/** Records what each render shows, and for whom. */
const seen: { user: string | null; dashboards: unknown }[] = [];
function CacheProbe() {
  const client = useQueryClient();
  const user = useSyncExternalStore(session.subscribe, session.get);
  seen.push({ user, dashboards: client.getQueryData(['dashboards']) });
  return null;
}

test('never renders the previous account’s data for the new one', async () => {
  installEventSource();
  seen.length = 0;
  await render(
    <PlatformEventsProvider>
      <CacheProbe />
    </PlatformEventsProvider>,
  );
  queryClient.setQueryData(['dashboards'], ['owner-dashboard']);
  session.set(null);
  await vi.waitFor(() =>
    expect(FakeEventSource.instances[0]!.close).toHaveBeenCalledOnce(),
  );
  session.set('other');
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  await vi.waitFor(() =>
    expect(seen.some((render) => render.user === 'other')).toBe(true),
  );
  expect(
    seen.filter(
      (render) => render.user === 'other' && render.dashboards !== undefined,
    ),
  ).toEqual([]);
});

function SubscriptionProbe({ name }: { name: string }) {
  const [events, setEvents] = useState(0);
  const [resyncs, setResyncs] = useState(0);
  usePlatformEvent('app.deployment.activated', () => {
    setEvents((current) => current + 1);
  });
  usePlatformResync(() => {
    setResyncs((current) => current + 1);
  });
  return <output>{`${name}:${events}:${resyncs}`}</output>;
}

test('shares one named-event stream across subscribers and closes it', async () => {
  installEventSource();
  const screen = await render(
    <PlatformEventsProvider>
      <SubscriptionProbe name="first" />
      <SubscriptionProbe name="second" />
    </PlatformEventsProvider>,
  );

  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  expect(source?.url).toBe('/api/events');

  source?.emit('platform', {
    type: 'app.deployment.activated',
    appId: 'malformed-without-revision',
  });
  source?.emit('platform', {
    type: 'app.deployment.activated',
    appId: 'app-one',
    deploymentRevision: 'revision-two',
  } satisfies PlatformEvent);
  source?.emit('resync');

  await expect.element(screen.getByText('first:1:1')).toBeVisible();
  await expect.element(screen.getByText('second:1:1')).toBeVisible();

  screen.unmount();
  expect(source?.close).toHaveBeenCalledOnce();
});

function UpdateProbe({
  appId = 'app-one',
  initialRevision = 'revision-one',
  revisionReader = async () => initialRevision,
  refreshGate,
}: {
  appId?: string;
  initialRevision?: string | null;
  revisionReader?: (appId: string) => Promise<string | null>;
  refreshGate?: Promise<void>;
}) {
  const [baseline, setBaseline] = useState(initialRevision);
  const { pendingRevision, updateAvailable } = useAppDeploymentUpdate({
    appId,
    deploymentRevision: baseline,
    revisionReader,
  });

  return (
    <>
      <output data-testid="available">{String(updateAvailable)}</output>
      <output data-testid="pending">{pendingRevision ?? 'none'}</output>
      <button
        type="button"
        onClick={() => {
          if (refreshGate) {
            void refreshGate.then(() => setBaseline('revision-two'));
          } else {
            setBaseline('revision-two');
          }
        }}
      >
        Load revision two
      </button>
      <button type="button" onClick={() => setBaseline('revision-three')}>
        Load revision three
      </button>
    </>
  );
}

function emitDeployment(
  source: FakeEventSource,
  appId: string,
  deploymentRevision: string,
) {
  source.emit('platform', {
    type: 'app.deployment.activated',
    appId,
    deploymentRevision,
  } satisfies PlatformEvent);
}

test('only marks a different revision for the canonical current app', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  emitDeployment(source, 'another-app', 'revision-two');
  emitDeployment(source, 'app-one', 'revision-one');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');

  authoritativeRevision = 'revision-two';
  emitDeployment(source, 'app-one', 'revision-two');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-two');

  await screen.getByRole('button', { name: 'Load revision two' }).click();
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');
  await expect.element(screen.getByTestId('pending')).toHaveTextContent('none');

  await screen.getByRole('button', { name: 'Load revision three' }).click();
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');
  await expect.element(screen.getByTestId('pending')).toHaveTextContent('none');
});

test('mount reconciliation recovers a deployment missed before subscription', async () => {
  installEventSource();
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve('revision-one'),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe initialRevision={null} revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-one'));
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-one');
});

test('resync rechecks durable deployment state after reconnect', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  authoritativeRevision = 'revision-two';
  source.emit('resync');

  await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-two');
});

test('a slow reconciliation cannot replace a newer event', async () => {
  installEventSource();
  let resolveRevision: ((revision: string | null) => void) | undefined;
  const reader = vi.fn<() => Promise<string | null>>(
    () =>
      new Promise<string | null>((resolve) => {
        resolveRevision = resolve;
      }),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
  emitDeployment(source, 'app-one', 'revision-three');
  resolveRevision?.('revision-two');

  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-three');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
});

test('an update arriving during refresh remains pending', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  let completeRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    completeRefresh = resolve;
  });
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe refreshGate={refreshGate} revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  authoritativeRevision = 'revision-two';
  emitDeployment(source, 'app-one', 'revision-two');
  await screen.getByRole('button', { name: 'Load revision two' }).click();
  authoritativeRevision = 'revision-three';
  emitDeployment(source, 'app-one', 'revision-three');
  completeRefresh?.();

  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-three');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
});

function SwitchingAppProbe({
  revisionReader,
}: {
  revisionReader: (appId: string) => Promise<string | null>;
}) {
  const [appId, setAppId] = useState('app-one');
  const { pendingRevision, updateAvailable } = useAppDeploymentUpdate({
    appId,
    deploymentRevision: 'revision-one',
    revisionReader,
  });
  return (
    <>
      <output data-testid="app-id">{appId}</output>
      <output data-testid="available">{String(updateAvailable)}</output>
      <output data-testid="pending">{pendingRevision ?? 'none'}</output>
      <button type="button" onClick={() => setAppId('app-two')}>
        Switch app
      </button>
    </>
  );
}

test('ignores a reconciliation response from the previously viewed app', async () => {
  installEventSource();
  let resolveFirst: ((revision: string | null) => void) | undefined;
  const reader = vi.fn<(appId: string) => Promise<string | null>>((appId) => {
    if (appId === 'app-one') {
      return new Promise<string | null>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve('revision-one');
  });
  const screen = await render(
    <PlatformEventsProvider>
      <SwitchingAppProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-one'));

  await screen.getByRole('button', { name: 'Switch app' }).click();
  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-two'));
  resolveFirst?.('revision-two');

  await expect
    .element(screen.getByTestId('app-id'))
    .toHaveTextContent('app-two');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');
  await expect.element(screen.getByTestId('pending')).toHaveTextContent('none');
});

test('re-reads the theme when it changes and after every reconnect', async () => {
  installEventSource();
  await render(
    <PlatformEventsProvider>
      <SubscriptionProbe name="probe" />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  const { queryKey } = themeQueryOptions('owner');
  const stale = () => queryClient.getQueryState(queryKey)?.isInvalidated;
  const markFresh = () =>
    queryClient.setQueryData(queryKey, {
      userId: 'owner',
      accent: 'indigo',
      defaultAccent: 'indigo',
      accents: [],
      dockLabels: false,
      // Only the query's freshness matters here.
    } as unknown as WebTheme);

  markFresh();
  source?.emit('platform', {
    type: 'theme.updated',
    userId: 'owner',
    accent: 'teal',
  } satisfies PlatformEvent);
  await vi.waitFor(() => expect(stale()).toBe(true));

  // A library change goes to everyone: their theme may be the one changed.
  markFresh();
  queryClient.setQueryData(['theme', 'library'], []);
  source?.emit('platform', { type: 'themes.updated' } satisfies PlatformEvent);
  await vi.waitFor(() => expect(stale()).toBe(true));
  expect(queryClient.getQueryState(['theme', 'library'])?.isInvalidated).toBe(
    true,
  );

  markFresh();
  source?.emit('resync');
  await vi.waitFor(() => expect(stale()).toBe(true));
});
