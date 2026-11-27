/**
 * The viewing user's theme as native App players apply it (NSH `cssVars`).
 * The player runs on the platform's origin, so the request carries the
 * user's session (on the phone, the surface handoff's); without one it
 * answers the default theme. A player reads it on start, when its surface
 * reports a theme change, and when it returns to the foreground.
 */
import { createHash } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { auth } from '~auth/server';
import { nshThemeFor } from '~server/apps/native/nsh-theme';
import { getTheme } from '~server/theme-settings';

export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  const { theme: state, resolved } = await getTheme(session?.user.id ?? null, {
    resolve: true,
  });
  const theme = nshThemeFor(resolved!);
  const body = JSON.stringify({
    appearance: state.theme.appearance,
    // Changes whenever anything the player would draw changes.
    key: createHash('sha256')
      .update(JSON.stringify(theme))
      .digest('hex')
      .slice(0, 16),
    theme,
  });
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

export const Route = createFileRoute('/api/theme/native')({
  server: { handlers: { GET: handle } },
});
