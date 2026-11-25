import { createFileRoute } from '@tanstack/react-router';
import { serveNshRuntimeFile } from '~server/apps/native/runtime-store';

/** The shared NSH web runtime native App player pages load. */
export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/app-runtime\/nsh\/([^/]+)\/(.+)$/);
  if (!match) return new Response('Not found', { status: 404 });
  let relative: string;
  try {
    relative = decodeURIComponent(match[2]);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  return serveNshRuntimeFile(
    match[1],
    relative,
    request.headers.get('accept-encoding'),
  );
}

export const Route = createFileRoute('/api/app-runtime/nsh/$version/$')({
  server: {
    handlers: {
      GET: handle,
    },
  },
});
