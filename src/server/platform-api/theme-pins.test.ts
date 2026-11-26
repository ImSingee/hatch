/**
 * Theme and pin RPCs: personal to the acting user, open to every credential
 * type, validated at the edge.
 */
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
vi.stubEnv('SECRET', 'theme-pins-test-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://hatch.example.test');

const { db, schema } = await import('~/db');
const { handlePlatformApiRequest } = await import('./http');

const user = { id: 'u1', email: 'owner@example.test', name: 'Owner' };
const other = { id: 'u2', email: 'other@example.test', name: 'Other' };
const OTHER_SESSION: PublicApiContext = {
  run: null,
  session: { id: 's2', expiresAt: new Date(Date.now() + 60_000) },
  status: {
    authenticated: true,
    credentialType: 'session',
    authority: 'platform',
    expiresAt: null,
    user: other,
  },
};
/** A Run credential whose run no user prompted. */
const USERLESS_RUN = {
  run: { runId: 'r0', sessionId: 'as0', runnerId: 'rn1' },
} as PublicApiContext;
/** Every credential type, each acting for `user`. */
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

/** The caller's dashboards in their order; JSON leaves out a false flag. */
async function dashboardPins() {
  const { data } = await call('DashboardService/ListDashboards');
  return (data.dashboards as { id: string; pinned?: boolean }[]).map(
    ({ id, pinned }) => ({ id, pinned: pinned ?? false }),
  );
}

beforeEach(async () => {
  fixture.credential = CREDENTIALS.session;
  await db.delete(schema.sidebarItems);
  await db.delete(schema.dashboards);
  await db.delete(schema.apps);
  await db.delete(schema.agentSessions);
  await db.delete(schema.user);
  await db.insert(schema.user).values([user, other]);
  await db
    .insert(schema.apps)
    .values({ id: 'app-notes', slug: 'notes', name: 'Notes' });
  await db.insert(schema.agentSessions).values([{ id: 'as1' }, { id: 'as0' }]);
  await db.insert(schema.agentRuns).values(
    [
      { id: 'r1', sessionId: 'as1', userId: user.id },
      { id: 'r0', sessionId: 'as0', userId: null },
    ].map((run) => ({
      ...run,
      providerId: 'fixture',
      modelId: 'fixture',
      input: { text: 'fixture' },
    })),
  );
});

describe('theme and pin RPCs', () => {
  it('give every credential type the same authority', async () => {
    for (const [type, credential] of Object.entries(CREDENTIALS)) {
      fixture.credential = credential;
      const set = await call('ThemeService/SetTheme', { accent: 'teal' });
      expect({ type, status: set.status }).toEqual({ type, status: 200 });
      expect(set.data.theme.accent).toBe('teal');
      expect((await call('ThemeService/GetTheme')).data.theme).toMatchObject({
        accent: 'teal',
        defaultAccent: 'indigo',
      });
      // Dock names change on their own; the accent is kept.
      const labels = await call('ThemeService/SetTheme', { dockLabels: true });
      expect({ type, status: labels.status }).toEqual({ type, status: 200 });
      expect(labels.data.theme).toMatchObject({
        accent: 'teal',
        dockLabels: true,
      });
      // Presence counts, not the value: false is a change of its own.
      const hidden = await call('ThemeService/SetTheme', { dockLabels: false });
      expect({ type, status: hidden.status }).toEqual({ type, status: 200 });
      expect(hidden.data.theme.dockLabels ?? false).toBe(false);
      const pinned = await call('PinService/PinApp', { app: 'notes' });
      expect({ type, status: pinned.status }).toEqual({ type, status: 200 });
      const listed = await call('PinService/ListPins');
      expect({ type, status: listed.status }).toEqual({ type, status: 200 });
      expect(listed.data.appPins).toHaveLength(1);
      expect(
        (await call('PinService/UnpinApp', { pinId: pinned.data.pin.id })).data,
      ).toEqual({ removedPinIds: [pinned.data.pin.id] });
    }
    fixture.credential = undefined;
    expect((await call('ThemeService/GetTheme')).status).toBe(401);
    expect((await call('PinService/ListPins')).status).toBe(401);
  });

  it('keep every user’s theme and pins to that user, for every credential', async () => {
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'Home', createdAt: new Date('2026-01-01') },
      { id: 'd2', name: 'Ops', createdAt: new Date('2026-01-02') },
    ]);
    fixture.credential = OTHER_SESSION;
    const theirs = (await call('PinService/PinApp', { app: 'notes' })).data.pin;
    await call('PinService/SetDashboardPinned', {
      dashboardId: 'd1',
      pinned: true,
    });
    for (const [type, credential] of Object.entries(CREDENTIALS)) {
      fixture.credential = credential;
      const changes = [
        await call('ThemeService/SetTheme', { accent: 'teal' }),
        await call('PinService/PinApp', { app: 'notes', label: type }),
        await call('PinService/ReorderDashboards', { dashboardIds: ['d2'] }),
        await call('PinService/SetDashboardPinned', {
          dashboardId: 'd2',
          pinned: true,
        }),
      ];
      expect({
        type,
        statuses: changes.map((change) => change.status),
      }).toEqual({ type, statuses: [200, 200, 200, 200] });
      // Another user's pin is not found, and stays as it was.
      for (const [method, body] of [
        ['PinService/UpdateAppPin', { id: theirs.id, label: 'Taken' }],
        ['PinService/UnpinApp', { pinId: theirs.id }],
        ['PinService/ReorderAppPins', { pinIds: [theirs.id] }],
      ] as const)
        expect({
          type,
          method,
          status: (await call(method, body)).status,
        }).toEqual({ type, method, status: 404 });
    }
    fixture.credential = CREDENTIALS['api-key'];
    expect((await call('PinService/ListPins')).data).toMatchObject({
      appPins: [{ label: 'session' }, { label: 'api-key' }, { label: 'run' }],
      // d1, the oldest, was pinned on the user's first visit.
      dashboards: [{ id: 'd2' }, { id: 'd1' }],
    });
    expect(await dashboardPins()).toEqual([
      { id: 'd2', pinned: true },
      { id: 'd1', pinned: true },
    ]);

    fixture.credential = OTHER_SESSION;
    expect((await call('ThemeService/GetTheme')).data.theme.accent).toBe(
      'indigo',
    );
    expect((await call('PinService/ListPins')).data).toMatchObject({
      appPins: [{ id: theirs.id, label: 'Notes' }],
      dashboards: [{ id: 'd1' }],
    });
    expect(await dashboardPins()).toEqual([
      { id: 'd1', pinned: true },
      { id: 'd2', pinned: false },
    ]);
  });

  it('pin a new dashboard for the user who created it', async () => {
    await db.insert(schema.dashboards).values({ id: 'd1', name: 'Home' });
    fixture.credential = CREDENTIALS.run;
    const created = await call('DashboardService/CreateDashboard', {
      name: 'Mine',
    });
    expect(created.data.dashboard).toMatchObject({ pinned: true });
    fixture.credential = OTHER_SESSION;
    expect(
      (
        await call('DashboardService/GetDashboard', {
          id: created.data.dashboard.id,
        })
      ).data.detail.dashboard.pinned ?? false,
    ).toBe(false);
  });

  it('give a Run no user prompted shared dashboards but no personal settings', async () => {
    fixture.credential = USERLESS_RUN;
    for (const method of [
      'ThemeService/GetTheme',
      'PinService/ListPins',
    ] as const)
      expect({ method, status: (await call(method)).status }).toEqual({
        method,
        status: 409,
      });
    const listed = await call('DashboardService/ListDashboards');
    expect(listed.status).toBe(200);
    const created = await call('DashboardService/CreateDashboard', {
      name: 'Shared',
    });
    expect(created.status).toBe(200);
    expect(created.data.dashboard.pinned ?? false).toBe(false);
    expect(
      (
        await call('DashboardService/UpdateDashboard', {
          id: created.data.dashboard.id,
          name: 'Renamed',
        })
      ).status,
    ).toBe(200);
  });

  it('reject malformed and unknown input without changing state', async () => {
    for (const [method, body] of [
      ['ThemeService/SetTheme', {}],
      ['ThemeService/SetTheme', { accent: 'Teal!' }],
      // Well-formed, but not an accent of this instance.
      ['ThemeService/SetTheme', { accent: 'orange' }],
      ['PinService/PinApp', {}],
      ['PinService/PinApp', { app: 'notes', ifAbsent: true, label: 'Inbox' }],
      ['PinService/UpdateAppPin', { id: 'p1' }],
      ['PinService/UnpinApp', {}],
      ['PinService/ReorderAppPins', { pinIds: [] }],
      ['PinService/ReorderAppPins', { pinIds: ['a', 'a'] }],
      ['PinService/ReorderDashboards', { dashboardIds: [] }],
      ['PinService/ListPins', { limit: 101 }],
      ['PinService/ListPins', { cursor: 'next' }],
    ] as const)
      expect({
        method,
        body,
        status: (await call(method, body)).status,
      }).toEqual({ method, body, status: 400 });
    expect((await call('PinService/PinApp', { app: 'nope' })).status).toBe(404);
    expect((await call('ThemeService/GetTheme')).data.theme.accent).toBe(
      'indigo',
    );
    expect((await call('PinService/ListPins')).data.appPins ?? []).toEqual([]);
  });

  it('page one sequence of App pins and dashboards', async () => {
    for (const label of ['Inbox', 'Archive', 'Drafts'])
      await call('PinService/PinApp', { app: 'notes', label });
    const whole = (await call('PinService/ListPins')).data;
    expect(whole.nextCursor).toBeUndefined();
    const flat = (data: typeof whole) => [
      ...(data.appPins ?? []).map((pin: { id: string }) => pin.id),
      ...(data.dashboards ?? []).map((pin: { id: string }) => pin.id),
    ];
    // Three App pins and the default dashboard.
    expect(flat(whole)).toHaveLength(4);
    const paged: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { data } = await call('PinService/ListPins', { limit: 2, cursor });
      paged.push(...flat(data));
      cursor = data.nextCursor;
      pages += 1;
    } while (cursor);
    expect({ pages, paged }).toEqual({ pages: 2, paged: flat(whole) });
  });

  it('clear a pin entry point only when the field is sent empty', async () => {
    const { data } = await call('PinService/PinApp', {
      app: 'notes',
      entryHash: '#/inbox',
    });
    expect(data.pin.entryHash).toBe('/inbox');
    const renamed = await call('PinService/UpdateAppPin', {
      id: data.pin.id,
      label: 'Inbox',
    });
    expect(renamed.data.pin).toMatchObject({
      label: 'Inbox',
      entryHash: '/inbox',
    });
    const cleared = await call('PinService/UpdateAppPin', {
      id: data.pin.id,
      entryHash: '',
    });
    expect(cleared.data.pin.label).toBe('Inbox');
    expect(cleared.data.pin.entryHash).toBeUndefined();
  });
});
