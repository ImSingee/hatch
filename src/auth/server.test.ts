import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn<(options: unknown) => unknown>((options) => options),
  database: {},
  drizzleAdapter: vi.fn<(database: unknown, options: unknown) => string>(
    () => 'database-adapter',
  ),
  passkey: vi.fn<(options: unknown) => string>(() => 'passkey'),
  deviceAuthorization: vi.fn<(options: unknown) => string>(
    () => 'device-authorization',
  ),
  bearer: vi.fn<() => string>(() => 'bearer'),
  schema: {},
  tanstackStartCookies: vi.fn<() => string>(() => 'tanstack-start-cookies'),
  trustedOrigin: vi.fn<() => string | null>(() => null),
}));

vi.mock('better-auth/minimal', () => ({
  betterAuth: mocks.betterAuth,
}));

vi.mock('@better-auth/drizzle-adapter/relations-v2', () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: mocks.tanstackStartCookies,
}));

vi.mock('@better-auth/passkey', () => ({
  passkey: mocks.passkey,
}));

vi.mock('better-auth/plugins/device-authorization', () => ({
  deviceAuthorization: mocks.deviceAuthorization,
}));

vi.mock('better-auth/plugins/bearer', () => ({
  bearer: mocks.bearer,
}));

vi.mock('../db', () => ({
  db: mocks.database,
  schema: mocks.schema,
}));

vi.mock('./signup-gate', () => ({
  assertSignupAllowed: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../server/tailscale-manager', () => ({
  getTailscaleManager: () => ({ trustedOrigin: mocks.trustedOrigin }),
}));

describe('Better Auth configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');
    vi.stubEnv('APP_URL', '  https://app.example.test:8443/  ');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the normalized APP_URL as its base URL', async () => {
    await import('./server');

    expect(mocks.betterAuth).toHaveBeenCalledOnce();
    expect(mocks.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://app.example.test:8443',
        secret: 'auth-secret',
      }),
    );
    expect(mocks.drizzleAdapter).toHaveBeenCalledWith(mocks.database, {
      provider: 'pg',
      schema: mocks.schema,
    });
    expect(mocks.passkey).toHaveBeenCalledWith({
      rpID: 'app.example.test',
      rpName: 'Hatch',
      registration: { requireSession: true },
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
      },
    });
  });

  it('trusts only the active node origin and revokes it immediately after disconnect', async () => {
    await import('./server');
    const options = mocks.betterAuth.mock.calls[0]![0] as {
      trustedOrigins: () => Promise<string[]>;
    };
    mocks.trustedOrigin.mockReturnValue('https://hatch.example.ts.net');
    await expect(options.trustedOrigins()).resolves.toEqual([
      'https://hatch.example.ts.net',
    ]);
    mocks.trustedOrigin.mockReturnValue(null);
    await expect(options.trustedOrigins()).resolves.toEqual([]);
  });

  it('refuses a client-chosen user.image on sign-up and profile updates', async () => {
    await import('./server');
    const options = mocks.betterAuth.mock.calls[0]![0] as {
      hooks: { before: (context: unknown) => Promise<unknown> };
    };
    const call = (path: string, body: Record<string, unknown>) =>
      options.hooks.before({ path, body, headers: new Headers() });

    for (const path of ['/sign-up/email', '/update-user'])
      for (const image of ['https://example.com/a.png', '', null])
        await expect(call(path, { name: 'A', image })).rejects.toMatchObject({
          body: { code: 'USER_IMAGE_READ_ONLY' },
        });
    await expect(call('/update-user', { name: 'A' })).resolves.toBeUndefined();
  });
});
