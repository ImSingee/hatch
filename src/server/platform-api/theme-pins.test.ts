/** Theme and pin RPCs: open to every credential type, validated at the edge. */
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

beforeEach(async () => {
  fixture.credential = CREDENTIALS.session;
  await db.delete(schema.platformConfig);
  await db.delete(schema.sidebarItems);
  await db.delete(schema.apps);
  await db
    .insert(schema.apps)
    .values({ id: 'app-notes', slug: 'notes', name: 'Notes' });
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
      ['PinService/SetWorkflowPinned', { pinned: true }],
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
