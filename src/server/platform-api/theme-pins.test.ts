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
    expect((await call('ThemeService/GetTheme')).data.theme.accent).toBe(
      'indigo',
    );
    expect((await call('PinService/ListPins')).data.appPins ?? []).toEqual([]);
  });

  it('give every credential type the same authority over modes, presets and custom themes', async () => {
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
      const mode = await call('ThemeService/SetTheme', {
        mode: 'system',
        appearance: 'dark',
        preset: 'desk-dark',
      });
      ok(mode);
      const custom = await call('ThemeService/SetTheme', {
        appearance: 'light',
        custom: meadow,
        clearAccent: true,
      });
      ok(custom);
      expect(custom.data.theme).toMatchObject({
        mode: 'system',
        light: {
          appearance: 'light',
          name: 'Meadow',
          custom: { name: 'Meadow' },
        },
        dark: { appearance: 'dark', preset: 'desk-dark' },
      });
      expect(custom.data.theme.accent ?? '').toBe('');
      const resolved = await call('ThemeService/GetTheme', {
        resolve: ['dark', 'light'],
      });
      ok(resolved);
      expect(
        resolved.data.resolved.map(
          (theme: { appearance: string; colors: Record<string, string> }) => [
            theme.appearance,
            theme.colors.primary,
          ],
        ),
      ).toEqual([
        ['dark', '#3F51C7'],
        ['light', '#2F6B3A'],
      ]);
      expect(resolved.data.resolved[0].ramps.primary.shades).toHaveLength(10);
      const presets = await call('ThemeService/ListThemePresets');
      ok(presets);
      expect(
        presets.data.presets.map((preset: { name: string }) => preset.name),
      ).toEqual(['desk', 'desk-dark']);
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
      const rejected = await call('ThemeService/SetTheme', {
        appearance: 'light',
        custom: { ...meadow, colors: { ...meadow.colors, card: 'cream' } },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.data.message).toContain(
        'colors.card is not an opaque colour',
      );
      const reset = await call('ThemeService/ResetTheme');
      ok(reset);
      expect(reset.data.theme).toMatchObject({
        accent: 'indigo',
        mode: 'light',
        light: { preset: 'desk' },
      });
    }
  });

  it('reject contradictory theme requests at the edge', async () => {
    for (const body of [
      { preset: 'desk' },
      { custom: { appearance: 'light' } },
      { appearance: 'light' },
      { appearance: 'light', preset: 'desk', custom: { appearance: 'light' } },
      { accent: 'teal', clearAccent: true },
      { mode: 'dim' },
      { appearance: 'sepia', preset: 'desk' },
    ])
      expect({
        body,
        status: (await call('ThemeService/SetTheme', body)).status,
      }).toEqual({ body, status: 400 });
    for (const resolve of [['sepia'], ['light', 'light']])
      expect((await call('ThemeService/GetTheme', { resolve })).status).toBe(
        400,
      );
    expect((await call('ThemeService/ValidateTheme', {})).status).toBe(400);
    expect((await call('ThemeService/GetTheme')).data.theme).toMatchObject({
      mode: 'light',
      light: { preset: 'desk' },
    });
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
