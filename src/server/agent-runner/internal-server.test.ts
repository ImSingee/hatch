import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInternalHttpHandler } from './internal-server';

// Unauthorized requests are rejected before any database or auth access.
vi.mock('~/db', async () => ({
  db: {},
  schema: await import('~/db/schema'),
}));
vi.mock('~auth/server', () => ({ auth: {} }));

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer(
    createInternalHttpHandler('runner-secret', 'builder-secret'),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Internal server test did not bind TCP.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('internal server authentication', () => {
  it.each(['/internal/api/runs', '/internal/api/agent-sessions'])(
    'does not expose %s anonymously',
    async (pathname) => {
      const response = await fetch(`${origin}${pathname}`);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Unauthorized',
      });
    },
  );

  // Each token is checked against the route dispatch reads, whatever the
  // raw path spells: a Builder cannot reach Runner routes, nor the reverse.
  it.each([
    ['builder-secret', '/internal/api/builds/../runs/run-1/token', 'POST'],
    ['builder-secret', '/internal/api/builds/%2e%2e/runs/run-1/token', 'POST'],
    ['builder-secret', '/internal/api/builds/../agent-sessions', 'GET'],
    ['runner-secret', '/internal/api//builds/lease', 'POST'],
    ['runner-secret', '/internal/api/runs/../builds/lease', 'POST'],
  ])('refuses %s for %s', async (secret, pathname, method) => {
    // http.request sends the path as written; fetch would normalize it.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(
        `${origin}/`,
        {
          method,
          path: pathname,
          headers: { authorization: `Bearer ${secret}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(401);
  });
});
