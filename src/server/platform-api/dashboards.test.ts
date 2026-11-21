/** Dashboard RPCs: every credential type, the shared domain service, live events. */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicApiContext } from './auth';

const fixture = vi.hoisted(() => ({
  credential: undefined as PublicApiContext | undefined,
}));

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('./auth', async () => {
  const { publicApiError } = await import('./errors');
  return {
    authenticatePublicApi: async () => {
      if (!fixture.credential) throw publicApiError('UNAUTHORIZED');
      return fixture.credential;
    },
  };
});
vi.stubEnv('SECRET', 'dashboard-rpc-test-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://hatch.example.test');

const { db, schema } = await import('~/db');
const { handlePlatformApiRequest } = await import('./http');

const user = { id: 'u1', email: 'owner@example.test', name: 'Owner' };
const CREDENTIALS: Record<string, PublicApiContext> = {
  session: {
    run: null,
    session: { id: 's1', expiresAt: new Date(Date.now() + 60_000) },
    status: {
      authenticated: true,
      credentialType: 'session',
      authority: 'platform',
      expiresAt: null,
      user,
    },
  },
  'api-key': {
    run: null,
    status: {
      authenticated: true,
      credentialType: 'api-key',
      authority: 'platform',
      expiresAt: null,
      user,
      key: { id: 'k1', name: null },
    },
  },
  run: {
    run: { runId: 'r1', sessionId: 'as1', runnerId: 'rn1' },
  } as PublicApiContext,
};

async function call(method: string, body: unknown = {}) {
  const response = await handlePlatformApiRequest(
    new Request(
      `https://hatch.example.test/api/rpc/hatch.platform.v1.${method}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: JSON.stringify(body),
      },
    ),
  );
  return { status: response.status, data: await response.json() };
}

const { subscribePlatformEvents } = await import('~server/platform-events');

const capabilities = {
  database: false,
  frontend: true,
  widgets: true,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
};
const widget = (id: string, sizes: { w: number; h: number }[] = []) => ({
  id,
  name: id,
  url: `/api/apps/app-notes/widgets/${id}`,
  defaultSize: sizes[0] ?? { w: 4, h: 3 },
  supportedSizes: sizes,
});

beforeEach(async () => {
  fixture.credential = CREDENTIALS.session;
  await db.delete(schema.dashboards);
  await db.delete(schema.apps);
  await db.insert(schema.apps).values({
    id: 'app-notes',
    slug: 'notes',
    name: 'Notes',
    status: 'deployed',
    capabilities,
  });
  await db.insert(schema.deployments).values({
    id: 'deployment-notes',
    appId: 'app-notes',
    status: 'deployed',
    compatibilityVersion: 2,
    manifestNormalized: {
      name: 'Notes',
      app: { url: '/app/notes', routes: [] },
      widgets: [
        widget('summary'),
        widget('streak', [
          { w: 2, h: 2 },
          { w: 4, h: 2 },
        ]),
      ],
    },
  });
  await db
    .update(schema.apps)
    .set({ currentDeploymentId: 'deployment-notes' })
    .where(eq(schema.apps.id, 'app-notes'));
  await db
    .insert(schema.dashboards)
    .values({ id: 'home', name: 'Home', pinned: true, sortOrder: 0 });
});

type Layout = { id: string; x?: number; y?: number; w: number; h: number };
/** Proto JSON leaves zero numbers out. */
const at = (layout: Layout[], id: string) => {
  const item = layout.find((candidate) => candidate.id === id);
  return item && { x: item.x ?? 0, y: item.y ?? 0, w: item.w, h: item.h };
};

describe('dashboard RPCs', () => {
  it('give every credential type the same authority', async () => {
    for (const [type, credential] of Object.entries(CREDENTIALS)) {
      fixture.credential = credential;
      const created = await call('DashboardService/CreateDashboard', {
        name: `Board ${type}`,
      });
      expect({ type, status: created.status }).toEqual({ type, status: 200 });
      const id = created.data.dashboard.id;
      const added = await call('DashboardService/AddDashboardWidget', {
        dashboardId: id,
        app: 'notes',
        widgetId: 'summary',
      });
      expect({ type, status: added.status }).toEqual({ type, status: 200 });
      expect(
        (await call('DashboardService/GetDashboard', { id })).data.detail
          .widgets,
      ).toHaveLength(1);
      expect(
        (await call('DashboardService/DeleteDashboard', { id })).status,
      ).toBe(200);
    }
    fixture.credential = undefined;
    expect((await call('DashboardService/ListDashboards')).status).toBe(401);
  });

  it('cover every editor operation and publish each change', async () => {
    const events: unknown[] = [];
    const stop = subscribePlatformEvents((event) => events.push(event));
    try {
      const updated = await call('DashboardService/UpdateDashboard', {
        id: 'home',
        name: 'Today',
        description: 'Morning view',
        autoRefreshSeconds: 60,
      });
      expect(updated.data.dashboard).toMatchObject({
        name: 'Today',
        description: 'Morning view',
        autoRefreshSeconds: 60,
      });
      // Present but empty clears; absent leaves unchanged.
      const cleared = await call('DashboardService/UpdateDashboard', {
        id: 'home',
        description: '',
      });
      expect(cleared.data.dashboard.description).toBeUndefined();
      expect(cleared.data.dashboard.name).toBe('Today');

      const available = await call('DashboardService/ListAvailableWidgets');
      expect(
        available.data.widgets.map(
          (item: { widgetId: string }) => item.widgetId,
        ),
      ).toEqual(['summary', 'streak']);

      const first = await call('DashboardService/AddDashboardWidget', {
        dashboardId: 'home',
        app: 'notes',
        widgetId: 'summary',
      });
      const second = await call('DashboardService/AddDashboardWidget', {
        dashboardId: 'home',
        app: 'app-notes',
        widgetId: 'streak',
        position: { breakpoint: 'desktop', x: 0, y: 0, w: 4, h: 2 },
      });
      const streak = second.data.placementId;
      const summary = first.data.placementId;
      // The widget placed at the top pushes the one it lands on down, and
      // every breakpoint holds both widgets.
      const desktop = second.data.detail.layouts.desktop;
      expect(at(desktop, streak)).toEqual({ x: 0, y: 0, w: 4, h: 2 });
      expect(at(desktop, summary)?.y).toBe(2);
      for (const breakpoint of ['desktop', 'tablet', 'mobile'])
        expect(second.data.detail.layouts[breakpoint]).toHaveLength(2);

      // A widget can be placed once; a size it does not declare is refused.
      expect(
        (
          await call('DashboardService/AddDashboardWidget', {
            dashboardId: 'home',
            app: 'notes',
            widgetId: 'summary',
          })
        ).status,
      ).toBe(409);
      const badSize = await call('DashboardService/SetDashboardWidgetLayout', {
        dashboardId: 'home',
        placementId: streak,
        position: { breakpoint: 'desktop', w: 3 },
      });
      expect(badSize.status).toBe(400);
      expect(badSize.data.message).toContain('2x2, 4x2');

      const moved = await call('DashboardService/SetDashboardWidgetLayout', {
        dashboardId: 'home',
        placementId: summary,
        position: { breakpoint: 'tablet', x: 4, w: 4 },
      });
      expect(at(moved.data.detail.layouts.tablet, summary)).toMatchObject({
        x: 4,
        w: 4,
      });

      const removed = await call('DashboardService/RemoveDashboardWidget', {
        dashboardId: 'home',
        placementId: streak,
      });
      expect(
        removed.data.detail.widgets.map((item: { id: string }) => item.id),
      ).toEqual([summary]);
      expect(removed.data.detail.revision).toBe(4);

      expect(
        events.filter(
          (event) => (event as { type: string }).type === 'dashboards.updated',
        ),
      ).toHaveLength(6);
    } finally {
      stop();
    }
  });

  it('reject malformed and unknown input without changing state', async () => {
    for (const [method, body, status] of [
      ['DashboardService/CreateDashboard', {}, 400],
      ['DashboardService/CreateDashboard', { name: '   ' }, 400],
      ['DashboardService/UpdateDashboard', { id: 'home' }, 400],
      [
        'DashboardService/UpdateDashboard',
        { id: 'home', autoRefreshSeconds: 3601 },
        400,
      ],
      ['DashboardService/UpdateDashboard', { id: 'nope', name: 'X' }, 404],
      ['DashboardService/GetDashboard', { id: 'nope' }, 404],
      [
        'DashboardService/AddDashboardWidget',
        { dashboardId: 'home', app: 'notes', widgetId: 'nope' },
        404,
      ],
      [
        'DashboardService/AddDashboardWidget',
        { dashboardId: 'home', app: 'nope', widgetId: 'summary' },
        404,
      ],
      [
        'DashboardService/AddDashboardWidget',
        {
          dashboardId: 'home',
          app: 'notes',
          widgetId: 'summary',
          position: { breakpoint: 'watch' },
        },
        400,
      ],
      [
        'DashboardService/AddDashboardWidget',
        {
          dashboardId: 'home',
          app: 'notes',
          widgetId: 'summary',
          position: { breakpoint: 'mobile', x: 2, w: 4 },
        },
        400,
      ],
      [
        'DashboardService/SetDashboardWidgetLayout',
        { dashboardId: 'home', placementId: 'p' },
        400,
      ],
      [
        'DashboardService/SetDashboardWidgetLayout',
        {
          dashboardId: 'home',
          placementId: 'p',
          position: { breakpoint: 'desktop', x: 1 },
        },
        404,
      ],
      [
        'DashboardService/RemoveDashboardWidget',
        { dashboardId: 'home', placementId: 'p' },
        404,
      ],
      // The last dashboard is kept.
      ['DashboardService/DeleteDashboard', { id: 'home' }, 409],
    ] as const)
      expect({
        method,
        body,
        status: (await call(method, body)).status,
      }).toEqual({ method, body, status });
    const detail = (await call('DashboardService/GetDashboard', { id: 'home' }))
      .data.detail;
    expect(detail.widgets ?? []).toEqual([]);
    expect(detail.revision ?? 0).toBe(0);
  });
});
