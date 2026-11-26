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
  await db.delete(schema.themes);
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
    // Still the fresh state: no accent.
    expect((await call('ThemeService/GetTheme')).data.theme.accent ?? '').toBe(
      '',
    );
    expect((await call('PinService/ListPins')).data.appPins ?? []).toEqual([]);
  });

  it('give every credential type the same authority over the theme library', async () => {
    const meadow = {
      name: 'Meadow',
      appearance: 'light',
      colors: {
        background: '#F3F6EF',
        foreground: '#1C2A1F',
        card: '#FFFFFF',
        primary: '#2F6B3A',
        secondary: '#E8EFE3',
        muted: '#E8EFE3',
        'muted-foreground': '#4B5B4E',
        border: '#D9E3D3',
        destructive: '#B91C1C',
      },
    };
    for (const [type, credential] of Object.entries(CREDENTIALS)) {
      fixture.credential = credential;
      const ok = (result: { status: number }) =>
        expect({ type, status: result.status }).toEqual({ type, status: 200 });
      const created = await call('ThemeService/CreateTheme', {
        document: meadow,
      });
      ok(created);
      const id = created.data.theme.id;
      expect(created.data.theme).toMatchObject({
        name: 'Meadow',
        source: 'custom',
        valid: true,
      });
      const listed = await call('ThemeService/ListThemes', { limit: 2 });
      ok(listed);
      expect(
        listed.data.themes.map((theme: { id: string }) => theme.id),
      ).toEqual(['desk', 'desk-dark']);
      expect(listed.data.nextCursor).toBe('2');
      const rest = await call('ThemeService/ListThemes', { cursor: '2' });
      expect(rest.data.themes[0].id).toBe(id);
      const dark = await call('ThemeService/SetTheme', {
        theme: 'desk-dark',
        clearAccent: true,
      });
      ok(dark);
      expect(dark.data.theme.theme).toMatchObject({
        id: 'desk-dark',
        appearance: 'dark',
      });
      const activated = await call('ThemeService/SetTheme', { theme: id });
      ok(activated);
      const resolved = await call('ThemeService/GetTheme', { resolve: true });
      ok(resolved);
      expect(resolved.data.resolved.colors.primary).toBe('#2F6B3A');
      expect(resolved.data.resolved.ramps.primary.shades).toHaveLength(10);
      const updated = await call('ThemeService/UpdateTheme', {
        id,
        document: { ...meadow, name: 'Meadow two' },
      });
      ok(updated);
      expect(updated.data.theme.name).toBe('Meadow two');
      const busy = await call('ThemeService/DeleteTheme', { id });
      expect({ type, status: busy.status }).toEqual({ type, status: 409 });
      const check = await call('ThemeService/ValidateTheme', {
        document: {
          ...meadow,
          colors: { ...meadow.colors, 'muted-foreground': '#B0B8B2' },
        },
      });
      ok(check);
      expect(check.data.ok ?? false).toBe(false);
      expect(check.data.problems[0]).toMatchObject({
        code: 'low_contrast',
        foreground: 'muted-foreground',
        background: 'background',
        requiredRatio: 4.5,
      });
      const rejected = await call('ThemeService/CreateTheme', {
        document: { ...meadow, colors: { ...meadow.colors, card: 'cream' } },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.data.message).toContain(
        'colors.card is not an opaque colour',
      );
      const reset = await call('ThemeService/ResetTheme');
      ok(reset);
      expect(reset.data.theme.theme).toMatchObject({
        id: 'desk',
        primary: '#3F51C7',
      });
      expect(reset.data.theme.accent ?? '').toBe('');
      const removed = await call('ThemeService/DeleteTheme', { id });
      ok(removed);
    }
  });

  it('reject malformed theme requests at the edge', async () => {
    for (const [method, body] of [
      ['ThemeService/SetTheme', { accent: 'teal', clearAccent: true }],
      ['ThemeService/SetTheme', { theme: 'Not An Id' }],
      ['ThemeService/ListThemes', { limit: 500 }],
      ['ThemeService/ListThemes', { cursor: 'next' }],
      ['ThemeService/CreateTheme', {}],
      ['ThemeService/UpdateTheme', { id: 'x' }],
      ['ThemeService/DeleteTheme', {}],
      ['ThemeService/ValidateTheme', {}],
    ] as const)
      expect({
        method,
        body,
        status: (await call(method, body)).status,
      }).toEqual({ method, body, status: 400 });
    expect(
      (await call('ThemeService/SetTheme', { theme: 'missing' })).status,
    ).toBe(404);
    expect((await call('ThemeService/GetTheme')).data.theme.theme.id).toBe(
      'desk',
    );
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
