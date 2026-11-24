/** Server info RPC: the running build, for every credential, never anonymous. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { PublicApiContext } from './auth';
import type { BuildInfo } from '~/build-info';

const fixture = vi.hoisted(() => ({
  credential: undefined as PublicApiContext | undefined,
  build: { commit: null, commitTime: null } as BuildInfo,
}));

vi.mock('~/build-info', () => ({
  get buildInfo() {
    return fixture.build;
  },
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
vi.stubEnv('SECRET', 'server-info-test-secret-at-least-32-characters');
vi.stubEnv('APP_URL', 'https://hatch.example.test');

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

async function getServerInfo() {
  const response = await handlePlatformApiRequest(
    new Request(
      'https://hatch.example.test/api/rpc/hatch.platform.v1.ServerService/GetServerInfo',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: '{}',
      },
    ),
  );
  return { status: response.status, data: await response.json() };
}

const commit = '1234567890abcdef1234567890abcdef12345678';
const commitTime = '2026-11-24T23:12:00+08:00';

beforeEach(() => {
  fixture.build = { commit, commitTime };
});

it.each(Object.keys(CREDENTIALS))(
  'returns the running build to a %s credential',
  async (type) => {
    fixture.credential = CREDENTIALS[type];
    expect(await getServerInfo()).toEqual({
      status: 200,
      data: { server: { commit, commitTime } },
    });
  },
);

it('omits the revision when the build recorded none', async () => {
  fixture.credential = CREDENTIALS.session;
  fixture.build = { commit: null, commitTime: null };
  expect(await getServerInfo()).toEqual({ status: 200, data: { server: {} } });
});

it('rejects a caller without a credential', async () => {
  fixture.credential = undefined;
  const { status, data } = await getServerInfo();
  expect(status).toBe(401);
  expect(data).not.toHaveProperty('server');
});
