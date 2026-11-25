import { Anchor, Text } from '@mantine/core';
import {
  hatchLinkWebUrl,
  isDocumentUrl,
} from '../../../packages/hatch-platform-api/deep-link';

/**
 * Where a notification link goes, as an anchor's attributes: a web page in a
 * new tab, a Hatch page by `hatch://` deep link on the instance it names
 * (here in this tab when that is this instance), or another app by its own
 * scheme. Null for a scheme that would run in this document; such a link is
 * shown as text only.
 */
export function notificationLinkTarget(
  url: string,
): { href: string; target?: '_blank'; rel?: 'noreferrer' } | null {
  if (isDocumentUrl(url)) return null;
  const page = hatchLinkWebUrl(url, window.location.origin, {
    allowLoopbackHttp: true,
  });
  const href = page ?? url;
  const web = /^https?:/i.test(href);
  const here = web && new URL(href).origin === window.location.origin;
  return web && !here
    ? { href, target: '_blank', rel: 'noreferrer' }
    : { href };
}

/**
 * A notification links to a web page, to another app by its own scheme
 * (`mailto:`, `someapp://…`), or, by `hatch://` deep link, to a Hatch page.
 * Links in a notification's content go the same way; nothing opens until it
 * is clicked.
 */
export function NotificationLink({ url }: { url: string }) {
  const target = notificationLinkTarget(url);
  if (!target)
    return (
      <Text size="sm" truncate>
        {url}
      </Text>
    );
  return (
    <Anchor {...target} size="sm" truncate>
      {url}
    </Anchor>
  );
}
