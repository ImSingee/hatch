/** Caller App backend for the App access integration test (Deno, deno-serve). */
import { connectApp } from '../../../../sdk-internal/app/src/apps';

/** A body of `size` bytes produced in chunks, never held whole. */
function stream(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(7);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const next = chunk.subarray(0, Math.min(chunk.byteLength, size - sent));
      sent += next.byteLength;
      controller.enqueue(next.slice());
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = connectApp('target');
    try {
      if (url.pathname === '/rpc') {
        return Response.json(
          await target.call('fixture.v1.Who/Get', { hello: 'there' }),
        );
      }
      if (url.pathname === '/upload') {
        const size = Number(url.searchParams.get('size'));
        const response = await target.webhook('/upload/clip.bin', {
          method: 'PUT',
          body: stream(size),
          // Deno needs this to send a streaming request body.
          duplex: 'half',
        } as RequestInit);
        return Response.json(await response.json());
      }
      if (url.pathname === '/denied') {
        await target.call('fixture.v1.Who/Delete', {});
        return Response.json({ unexpected: true });
      }
    } catch (error) {
      const failure = error as { code?: string; status?: number };
      return Response.json({ error: failure.code, status: failure.status });
    }
    return new Response('not found', { status: 404 });
  },
};
