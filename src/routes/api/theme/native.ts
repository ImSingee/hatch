/**
 * The instance theme as native App players apply it (NSH `cssVars`). Public,
 * like the theme itself (the login page is drawn in it): a player reads it
 * on start, when its surface reports a theme change, and when it returns to
 * the foreground.
 *
 * `appearance=light|dark` asks for that theme; `prefers=light|dark` says
 * what the device prefers and lets the instance's mode decide.
 */
import { createHash } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { nshThemeFor } from '~server/apps/native/nsh-theme';
import { appearanceFor, getTheme } from '~server/theme-settings';
import type { ThemeAppearance } from '../../../../packages/hatch-design-tokens/src';

function appearanceParam(value: string | null): ThemeAppearance | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export async function handle({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const asked = appearanceParam(params.get('appearance'));
  const prefers = appearanceParam(params.get('prefers'));
  if ((asked === null) === (prefers === null))
    return new Response('Give appearance=light|dark or prefers=light|dark.', {
      status: 400,
    });
  const {
    theme: state,
    resolved: [light, dark],
  } = await getTheme(['light', 'dark']);
  const appearance = asked ?? appearanceFor(state.mode, prefers!);
  const theme = nshThemeFor(appearance === 'light' ? light : dark);
  const body = JSON.stringify({
    appearance,
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
