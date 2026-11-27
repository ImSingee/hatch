/**
 * The instance's active theme as native App players apply it (NSH
 * `cssVars`). Public, like the theme itself (the login page is drawn in it):
 * a player reads it on start, when its surface reports a theme change, and
 * when it returns to the foreground.
 */
import { createHash } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { nshThemeFor } from '~server/apps/native/nsh-theme';
import { getTheme } from '~server/theme-settings';

export async function handle(): Promise<Response> {
  const { theme: state, resolved } = await getTheme({ resolve: true });
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
