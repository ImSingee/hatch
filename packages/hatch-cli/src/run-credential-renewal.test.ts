/** Run credential renewal inside each RPC's own deadline. */
import { createServer, type RequestListener, type Server } from 'node:http';
import { createClient } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkService } from '../../hatch-platform-api/gen/hatch/platform/v1/sdk_pb';
import { platformTransport } from './client';

const servers: Server[] = [];
async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A Run JWT that has already expired, so every request renews it first. */
const expired = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url'),
  'signature',
].join('.');
const renewed = 'renewed-run-token';

let platform: string;
/** Authorization headers the platform received. */
let seen: string[];
/** What the Runner's credential endpoint does with each request. */
let runner: (respond: (status: number, body?: unknown) => void) => void;
let renewals: number;
/** Resolves when the Runner sees its pending credential request dropped. */
let dropped: Promise<void>;

beforeEach(async () => {
  seen = [];
  renewals = 0;
  const rpc = connectNodeAdapter({
    requestPathPrefix: '/api/rpc',
    routes: (router) =>
      router.service(SdkService, {
        getSdk: (_request, context) => {
          seen.push(context.requestHeader.get('authorization') ?? '');
          return { files: [] };
        },
      }),
  });
  platform = await listen((request, response) => void rpc(request, response));
  const endpoint = await listen((_request, response) => {
    renewals++;
    dropped = new Promise((resolve) => response.once('close', () => resolve()));
    runner((status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  vi.stubEnv('HATCH_CLI_RUN_ENDPOINT', `${endpoint}/credential`);
  vi.stubEnv('HATCH_CLI_RUN_SECRET', 'a'.repeat(64));
  vi.stubEnv('HATCH_CLI_TOKEN', expired);
  vi.stubEnv('HATCH_CLI_URL', platform);
  vi.stubEnv('HATCH_CLI_API_KEY', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function sdkClient() {
  return createClient(
    SdkService,
    platformTransport(
      { url: platform, token: expired },
      30_000,
      new AbortController().signal,
    ),
  );
}

describe('Run credential renewal', () => {
  it('reports a renewal the Runner refuses as unavailable Run credentials', async () => {
    runner = (respond) => respond(500);
    await expect(sdkClient().getSdk({ kind: 'app' })).rejects.toMatchObject({
      code: 'run_credentials_unavailable',
      exitCode: 3,
    });
    expect(seen).toEqual([]);
  });

  it('ends a request at its own deadline while the renewal stalls', async () => {
    runner = () => {};
    const started = Date.now();
    await expect(
      sdkClient().getSdk({ kind: 'app' }, { timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'outcome_unknown', exitCode: 7 });
    // Well before the renewal's own ten-second limit.
    expect(Date.now() - started).toBeLessThan(3_000);
    // No request waits for the renewal any more, so it stops too.
    await expect(
      Promise.race([
        dropped.then(() => 'stopped'),
        new Promise((resolve) => setTimeout(resolve, 3_000, 'running')),
      ]),
    ).resolves.toBe('stopped');
  });

  it('keeps one shared renewal for a request with time left when another gives up', async () => {
    runner = (respond) =>
      setTimeout(() => respond(200, { token: renewed, url: platform }), 800);
    const client = sdkClient();
    const [short, long] = await Promise.allSettled([
      client.getSdk({ kind: 'app' }, { timeoutMs: 200 }),
      client.getSdk({ kind: 'app' }, { timeoutMs: 10_000 }),
    ]);
    expect(short).toMatchObject({
      status: 'rejected',
      reason: { code: 'outcome_unknown', exitCode: 7 },
    });
    expect(long.status).toBe('fulfilled');
    expect(renewals).toBe(1);
    expect(seen).toEqual([`Bearer ${renewed}`]);
  });
});
