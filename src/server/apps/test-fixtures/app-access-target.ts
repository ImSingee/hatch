/** Target App backend for the App access integration test (Deno, deno-serve). */
import {
  appCaller,
  verifyPlatformRequest,
} from '../../../../sdk-internal/app/src/apps';

async function countBytes(body: ReadableStream<Uint8Array> | null) {
  let bytes = 0;
  if (!body) return bytes;
  for await (const chunk of body) bytes += chunk.byteLength;
  return bytes;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/fixture.v1.Who/Get') {
      const caller = await appCaller(request);
      return Response.json({ caller, input: await request.json() });
    }
    if (url.pathname.startsWith('/__webhook/')) {
      // Check the signature before reading the body: relayed calls are
      // signed over method and path, so the body streams.
      const origin = request.headers.has('x-hatch-caller-app')
        ? await verifyPlatformRequest(request)
        : null;
      return Response.json({
        origin,
        path: url.pathname,
        bytes: await countBytes(request.body),
      });
    }
    return new Response('not found', { status: 404 });
  },
};
