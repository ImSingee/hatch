import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { getStatus, request } from './http';

const token = 'fixture-session-secret';
let server: Server | undefined;

async function listen(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close() {
  const current = server;
  server = undefined;
  if (current)
    await new Promise<void>((resolve) => current.close(() => resolve()));
}

function calls(url: string) {
  const signal = new AbortController().signal;
  return [
    getStatus({ url, token }, 5000, signal),
    request(url, '/api/auth/device/code', { body: {}, timeout: 5000, signal }),
  ];
}

describe('platform connection failures', () => {
  afterEach(close);

  it('reports an unreachable platform by URL, as safe to retry', async () => {
    // A port that was just freed refuses the connection.
    const url = await listen(() => {});
    await close();
    for (const call of calls(url))
      await expect(call).rejects.toMatchObject({
        code: 'network_error',
        exitCode: 7,
        message: `Cannot connect to the platform at ${url}. Check that it is running and that the URL is correct.`,
      });
  });

  it('keeps an unknown outcome once the request may have reached it', async () => {
    const url = await listen((incoming) => incoming.socket.destroy());
    for (const call of calls(url)) {
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'outcome_unknown', exitCode: 7 });
      expect((error as Error).message).toContain(url);
      expect((error as Error).message).not.toContain(token);
    }
  });
});
