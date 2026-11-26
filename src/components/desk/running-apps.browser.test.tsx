import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type AnyRootRoute,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  useParams,
} from '@tanstack/react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { AppDetail } from '~server/apps';
import { Route as AppRoute } from '~/routes/_app/app/$appSlug';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import { PlatformEventsProvider } from '~components/system/platform-events';
import { AppSessionsProvider, useAppSessions } from './app-sessions';
import { DeskShell } from './desk-shell';
import { DeskWindow } from './window';

// The real desk (shell, dock, session manager, platform events) around the
// real App route; stand-in pages for the rest. Browser Mode serves the App
// frames (vitest.config.ts): `native-*` slugs get a stand-in native player
// that records what the surface sends.

type Pin = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  entryHash: string | null;
};

const fixtures = vi.hoisted(() => ({
  pins: [] as Pin[],
  /** The live deployment of each App, as the platform reports it. */
  revisions: new Map<string, string>(),
  /** Apps whose live deployment has no frontend. */
  frontendless: new Set<string>(),
  rootRoute: null as AnyRootRoute | null,
}));

const NAMES: Record<string, string> = {
  notes: 'Notes',
  ledger: 'Ledger',
  garden: 'Garden',
  'native-tasks': 'Tasks',
};

function appDetail(slug: string): AppDetail {
  return {
    id: `id-${slug}`,
    slug,
    name: NAMES[slug] ?? slug,
    description: null,
    status: 'deployed',
    capabilities: {
      database: false,
      frontend: !fixtures.frontendless.has(slug),
      widgets: false,
      backend: false,
      cron: false,
      webhook: false,
      kv: false,
      dataTable: false,
    },
    deploymentRevision: fixtures.revisions.get(slug) ?? 'r1',
    compatibility: {
      version: 2,
      latestVersion: 2,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    },
    reservedShortcuts: [],
    currentSourceCommit: null,
    dbName: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    createFileRoute: () => (options: object) =>
      actual.createRoute({
        ...options,
        getParentRoute: () => fixtures.rootRoute!,
        path: '/app/$appSlug',
      }),
  };
});

vi.mock('~server/apps', () => {
  const unused = async () => null;
  return {
    getAppBySlug: async ({ data: slug }: { data: string }) =>
      NAMES[slug] ? appDetail(slug) : null,
    getAppDeploymentRevision: async ({ data: appId }: { data: string }) =>
      fixtures.revisions.get(appId.replace(/^id-/, '')) ?? 'r1',
    listApps: async () => Object.keys(NAMES).map(appDetail),
    getAppDocFn: unused,
    getAppOps: unused,
    getDeploymentBuildLog: unused,
    getNormalizedManifest: unused,
    inspectAppDataTablesFn: unused,
    listAppBackendsFn: unused,
    listAppKvFn: unused,
    listCronRunsFn: unused,
    listDeployments: unused,
  };
});
// The background time comes from the provider here, not the user's
// preference.
vi.mock('~server/desk-preference-settings', () => ({
  getDeskPreferenceSettings: async () => ({ backgroundAppMinutes: 5 }),
  updateDeskPreferenceSettings: async () => ({ backgroundAppMinutes: 5 }),
}));
vi.mock('~queries/agent', () => ({
  agentRunnerStatusQueryOptions: {
    queryKey: ['test-runner-status'],
    queryFn: async () => ({ state: 'connected', runners: [] }),
  },
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
    queryFn: async () => ({ accent: 'indigo', dockLabels: false }),
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
  useNotificationReadState: () => ({ data: { unreadCount: 0 } }),
}));
vi.mock('~components/apps/use-app-icon', () => ({
  appIconUrl: () => '',
  useAppIconKey: () => null,
  useHasAppIcons: () => false,
}));

/** The platform event stream, driven by the test. */
class TestEventSource extends EventTarget {
  static current: TestEventSource | null = null;
  constructor() {
    super();
    TestEventSource.current = this;
  }
  close() {}
}

let limit = 12;
/** Long enough that no test but the background-time one sees it. */
let backgroundTimeoutMs = 600_000;

function Shell() {
  const { dashboardId } = useParams({ strict: false }) as Record<
    string,
    string | undefined
  >;
  return (
    <PlatformEventsProvider>
      <AppSessionsProvider
        limit={limit}
        backgroundTimeoutMs={backgroundTimeoutMs}
      >
        <OpenItemsShell view={dashboardId ? 'home' : 'window'} />
      </AppSessionsProvider>
    </PlatformEventsProvider>
  );
}

// Mirrors `src/routes/_app.tsx`: the dock marks every running App.
function OpenItemsShell({ view }: { view: 'home' | 'window' }) {
  return (
    <DeskShell view={view} tabDestination={false} openItems={useOpenItems()}>
      <Outlet />
    </DeskShell>
  );
}

function useOpenItems() {
  const { sessions } = useAppSessions();
  return sessions.map((s) => ({
    kind: 'app' as const,
    slug: s.slug,
    route: s.route,
  }));
}

fixtures.rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({ component: Shell });

async function renderDesk(initialEntry: string) {
  const standIn = (path: string, title: string) =>
    createRoute({
      getParentRoute: () => fixtures.rootRoute!,
      path,
      component: () => (
        <DeskWindow title={title}>
          <label>
            {`${title} note`}
            <input />
          </label>
        </DeskWindow>
      ),
    });
  const router = createRouter({
    routeTree: fixtures.rootRoute!.addChildren([
      createRoute({
        getParentRoute: () => fixtures.rootRoute!,
        path: '/dashboard/$dashboardId',
        component: () => <div>Desk home</div>,
      }),
      standIn('/agent', 'Agent'),
      standIn('/apps', 'Apps'),
      AppRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: { queryClient: new QueryClient() },
  });
  const queryClient = router.options.context.queryClient;
  const screen = await render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { router, screen };
}

const frameOf = (slug: string) =>
  document.querySelector<HTMLIFrameElement>(
    `iframe[src="/app/${slug}/embed/"]`,
  );
const framesOf = (slug: string) =>
  document.querySelectorAll(`iframe[src="/app/${slug}/embed/"]`).length;
const windowOf = (slug: string) => frameOf(slug)?.closest('section') ?? null;
const placementOf = (slug: string) =>
  windowOf(slug)?.dataset.windowPlacement ?? null;

/** Wait until `slug`'s own document is loaded, and return its window. */
async function loaded(slug: string) {
  await vi.waitFor(() => {
    const frame = frameOf(slug);
    expect(frame?.contentWindow?.location.pathname).toBe(`/app/${slug}/embed/`);
    expect(frame?.contentDocument?.readyState).toBe('complete');
    expect(windowOf(slug)?.querySelector('.mantine-Loader-root')).toBeNull();
  });
  return frameOf(slug)!.contentWindow!;
}

function dockTile(name: string) {
  return page.getByRole('navigation', { name: 'Dock' }).getByRole('link', {
    name,
  });
}

/** Open the dock's right-click menu on a tile and pick an item. */
async function dockMenu(name: string, item: string) {
  const tile = dockTile(name).element();
  tile.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  let target: HTMLElement | undefined;
  await vi.waitFor(() => {
    target = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((element) => element.textContent?.trim() === item);
    expect(target).toBeTruthy();
  });
  target!.click();
}

beforeEach(() => {
  sessionStorage.clear();
  fixtures.pins = [];
  fixtures.revisions.clear();
  fixtures.frontendless.clear();
  limit = 12;
  backgroundTimeoutMs = 600_000;
  vi.stubGlobal('EventSource', TestEventSource);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await page.viewport(1280, 720);
});

test('switching away and back keeps a running App on the same screen with its unsaved input', async () => {
  fixtures.pins = [
    {
      id: 'pin-notes',
      appId: 'id-notes',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  const { router } = await renderDesk('/app/notes');
  const notes = await loaded('notes');
  const notesDocument = notes.document;
  notes.history.pushState(null, '', '#/drafts');
  const draft = notesDocument.createElement('textarea');
  notesDocument.body.append(draft);
  draft.value = 'Unsaved draft';
  // A long page, scrolled down.
  notesDocument.body.style.height = '4000px';
  notes.scrollTo(0, 900);
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/drafts'));

  // Another page, then another App, in front: Notes waits, still running.
  await router.navigate({ to: '/agent' });
  await expect
    .element(page.getByRole('heading', { name: 'Agent' }))
    .toBeVisible();
  expect(placementOf('notes')).toBe('hidden');
  expect(windowOf('notes')).not.toBeVisible();
  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'native-tasks' },
  });
  await loaded('native-tasks');
  expect(placementOf('notes')).toBe('hidden');

  // Its dock tile brings it back as it was left. (With a mouse the dock
  // waits below the edge; the tile's link is what matters here.)
  (dockTile('Notes').element() as HTMLElement).click();
  await vi.waitFor(() => expect(placementOf('notes')).toBe('front'));
  expect(frameOf('notes')!.contentDocument).toBe(notesDocument);
  expect(draft.value).toBe('Unsaved draft');
  expect(notes.scrollY).toBe(900);
  expect(notes.location.hash).toBe('#/drafts');
  expect(router.state.location.hash).toBe('/drafts');
  // The tab names the page the App in front is on.
  expect(document.title).toBe('Embedded app');
  expect(placementOf('native-tasks')).toBe('hidden');

  // Back goes to the App that was in front before, still running.
  router.history.back();
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('front'));
  expect(placementOf('notes')).toBe('hidden');
  expect(framesOf('notes')).toBe(1);
});

test('opening a running App focuses it instead of starting a second copy', async () => {
  const { router } = await renderDesk('/app/notes#/inbox');
  const notes = await loaded('notes');
  expect(notes.location.hash).toBe('#/inbox');
  await router.navigate({ to: '/agent' });

  // A bare link (All apps, a search result) brings it forward as it is.
  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/inbox'));
  expect(placementOf('notes')).toBe('front');
  expect(frameOf('notes')!.contentWindow).toBe(notes);

  // A link to a page of the App moves the running App there.
  await router.navigate({ to: '/agent' });
  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'notes' },
    hash: '/settings',
  });
  await vi.waitFor(() => expect(notes.location.hash).toBe('#/settings'));
  expect(frameOf('notes')!.contentWindow).toBe(notes);
  expect(framesOf('notes')).toBe(1);
});

test('past the limit the App shown least recently stops, and reopens where it was left', async () => {
  limit = 2;
  const { router } = await renderDesk('/app/notes');
  const open = (slug: string) =>
    router.navigate({ to: '/app/$appSlug', params: { appSlug: slug } });
  const notes = await loaded('notes');
  notes.history.pushState(null, '', '#/a');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/a'));
  await open('ledger');
  const ledger = await loaded('ledger');
  ledger.history.pushState(null, '', '#/b');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/b'));
  // Notes is shown again, so Ledger is now the one shown least recently.
  await open('notes');
  await vi.waitFor(() => expect(placementOf('notes')).toBe('front'));

  await open('garden');
  await loaded('garden');
  await vi.waitFor(() => expect(frameOf('ledger')).toBeNull());
  expect(frameOf('notes')!.contentWindow).toBe(notes);
  await expect.element(dockTile('Ledger')).not.toBeInTheDocument();
  await expect.element(dockTile('Notes')).toHaveAttribute('data-open', 'true');

  // Ledger opens again where it was; Notes is now the least recent.
  await open('ledger');
  const reopened = await loaded('ledger');
  expect(reopened.location.hash).toBe('#/b');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/b'));
  await vi.waitFor(() => expect(frameOf('notes')).toBeNull());
  expect(frameOf('garden')).not.toBeNull();
});

test('a minimised App stops after its background time and reopens where it was left', async () => {
  backgroundTimeoutMs = 600;
  const { router } = await renderDesk('/app/notes');
  const notes = await loaded('notes');
  notes.history.pushState(null, '', '#/drafts');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/drafts'));

  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'ledger' } });
  await loaded('ledger');
  // Within its time it keeps running in the background.
  expect(frameOf('notes')!.contentWindow).toBe(notes);
  await vi.waitFor(() => expect(frameOf('notes')).toBeNull(), {
    timeout: 3000,
  });
  // The App in front is never stopped.
  expect(placementOf('ledger')).toBe('front');

  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  expect((await loaded('notes')).location.hash).toBe('#/drafts');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/drafts'));
});

test('a new deployment marks a running App instead of replacing it', async () => {
  const { router } = await renderDesk('/app/notes');
  await loaded('notes');
  const frame = frameOf('notes');
  fixtures.revisions.set('notes', 'r2');
  TestEventSource.current!.dispatchEvent(
    new MessageEvent('platform', {
      data: JSON.stringify({
        type: 'app.deployment.activated',
        appId: 'id-notes',
        deploymentRevision: 'r2',
      }),
    }),
  );
  const pill = page.getByRole('button', {
    name: 'Update available — reload app',
  });
  await expect.element(pill).toBeVisible();
  expect(frameOf('notes')).toBe(frame);

  // Switching away and back (which re-reads the App) keeps the old bundle
  // running, and the mark.
  await router.navigate({ to: '/agent' });
  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  await vi.waitFor(() => expect(placementOf('notes')).toBe('front'));
  await expect.element(pill).toBeVisible();
  expect(frameOf('notes')).toBe(frame);

  // Reloading loads the new deployment.
  await pill.click();
  await vi.waitFor(() => expect(frameOf('notes')).not.toBe(frame));
  await expect
    .element(page.getByRole('button', { name: 'Reload app' }))
    .toBeVisible();
});

test('an App sits beside another window; below tablet width only the front one shows', async () => {
  const { router } = await renderDesk('/app/native-tasks');
  const player = (await loaded('native-tasks')) as Window & {
    received: { type: string; visible?: boolean }[];
  };
  await router.navigate({ to: '/agent' });
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('hidden'));

  await dockMenu('Tasks', 'Open beside');
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('beside'));
  const agent = page.getByRole('textbox', { name: 'Agent note' });
  await expect.element(agent).toBeVisible();
  expect(windowOf('native-tasks')).toBeVisible();
  const agentBox = agent.element().closest('section')!.getBoundingClientRect();
  const appBox = windowOf('native-tasks')!.getBoundingClientRect();
  expect(appBox.left).toBeGreaterThanOrEqual(agentBox.right);
  await vi.waitFor(() =>
    expect(player.received.at(-1)).toEqual({
      type: 'visibility',
      visible: true,
    }),
  );
  // Both stay usable: the page in front keeps its field, the URL its page.
  await agent.fill('Side by side');
  await expect.element(agent).toHaveValue('Side by side');
  expect(router.state.location.pathname).toBe('/agent');

  // Narrower than a tablet, only the front window shows; the App waits.
  await page.viewport(700, 720);
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('hidden'));
  await vi.waitFor(() =>
    expect(player.received.at(-1)).toEqual({
      type: 'visibility',
      visible: false,
    }),
  );
  await page.viewport(1280, 720);
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('beside'));

  // Minimising it beside leaves it running on the desk.
  await page.getByRole('button', { name: 'Minimise window' }).nth(1).click();
  await vi.waitFor(() => expect(placementOf('native-tasks')).toBe('hidden'));
  await expect.element(dockTile('Tasks')).toHaveAttribute('data-open', 'true');
});

test('the dock lists running Apps, and Quit or Close stops one', async () => {
  fixtures.pins = [
    {
      id: 'pin-notes',
      appId: 'id-notes',
      appSlug: 'notes',
      label: 'Notes',
      entryHash: null,
    },
  ];
  const { router } = await renderDesk('/app/ledger');
  await loaded('ledger');
  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  await loaded('notes');

  // The pinned App is marked; the unpinned one gets a tile while it runs.
  await expect.element(dockTile('Notes')).toHaveAttribute('data-open', 'true');
  await expect.element(dockTile('Ledger')).toHaveAttribute('data-open', 'true');

  await dockMenu('Ledger', 'Quit');
  await vi.waitFor(() => expect(frameOf('ledger')).toBeNull());
  await expect.element(dockTile('Ledger')).not.toBeInTheDocument();

  // Close stops the App in front and returns to the desk; it starts fresh.
  frameOf('notes')!.contentWindow!.history.pushState(null, '', '#/old');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/old'));
  await page
    .getByRole('link', { name: 'Close window, back to the desk' })
    .click();
  await vi.waitFor(() => expect(frameOf('notes')).toBeNull());
  await expect
    .element(dockTile('Notes'))
    .not.toHaveAttribute('data-open', 'true');
  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  expect((await loaded('notes')).location.hash).toBe('');
});

test('a reload keeps the App beside and reopens Apps where they were', async () => {
  const first = await renderDesk('/app/notes#/kept');
  await loaded('notes');
  await first.router.navigate({ to: '/agent' });
  await dockMenu('Notes', 'Open beside');
  await vi.waitFor(() => expect(placementOf('notes')).toBe('beside'));
  await first.router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'ledger' },
  });
  const ledger = await loaded('ledger');
  ledger.history.pushState(null, '', '#/month');
  await vi.waitFor(() =>
    expect(first.router.state.location.hash).toBe('/month'),
  );
  await first.screen.unmount();

  // The page loads again: the App beside comes back, still at its page, and
  // the others open where they were left.
  const second = await renderDesk('/agent');
  await vi.waitFor(() => expect(placementOf('notes')).toBe('beside'));
  expect((await loaded('notes')).location.hash).toBe('#/kept');
  expect(frameOf('ledger')).toBeNull();
  await second.router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'ledger' },
  });
  expect((await loaded('ledger')).location.hash).toBe('#/month');
  expect(second.router.state.location.hash).toBe('/month');
});

test('a new deployment that cannot run here keeps the running App until it is reloaded', async () => {
  const { router } = await renderDesk('/app/notes');
  await loaded('notes');
  const frame = frameOf('notes');
  fixtures.revisions.set('notes', 'r2');
  fixtures.frontendless.add('notes');
  TestEventSource.current!.dispatchEvent(
    new MessageEvent('platform', {
      data: JSON.stringify({
        type: 'app.deployment.activated',
        appId: 'id-notes',
        deploymentRevision: 'r2',
      }),
    }),
  );
  const pill = page.getByRole('button', {
    name: 'Update available — reload app',
  });
  await expect.element(pill).toBeVisible();

  // Coming back re-reads the App (now without a frontend): the running
  // bundle stays in front.
  await router.navigate({ to: '/agent' });
  await router.navigate({ to: '/app/$appSlug', params: { appSlug: 'notes' } });
  await vi.waitFor(() => expect(placementOf('notes')).toBe('front'));
  expect(frameOf('notes')).toBe(frame);

  // Reloading applies the deployment: the App stops and its page says why.
  await pill.click();
  await expect.element(page.getByText('Backend-only app')).toBeVisible();
  expect(frameOf('notes')).toBeNull();
});

test('Open beside reads the App afresh rather than trusting older details', async () => {
  fixtures.pins = [
    {
      id: 'pin-ledger',
      appId: 'id-ledger',
      appSlug: 'ledger',
      label: 'Ledger',
      entryHash: null,
    },
  ];
  // Seen before its frontend was deployed.
  fixtures.frontendless.add('ledger');
  const { router } = await renderDesk('/app/ledger');
  await expect.element(page.getByText('Backend-only app')).toBeVisible();
  fixtures.frontendless.delete('ledger');
  await router.navigate({ to: '/agent' });

  await dockMenu('Ledger', 'Open beside');

  await vi.waitFor(() => expect(placementOf('ledger')).toBe('beside'));
  await loaded('ledger');
});
