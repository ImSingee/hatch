import { Anchor, Text } from '@mantine/core';
import {
  hatchLinkWebUrl,
  isDocumentUrl,
} from '../../../packages/hatch-platform-api/deep-link';

/**
 * A notification links to a web page, to another app by its own scheme
 * (`mailto:`, `someapp://…`), or, by `hatch://` deep link, to a Hatch page:
 * that opens on the instance it names, here in this tab when that is this
 * instance. Other web pages open in a new tab; other schemes go to the app
 * the system has for them. A scheme that would run in this document is shown
 * as text only.
 */
export function NotificationLink({ url }: { url: string }) {
  if (isDocumentUrl(url))
    return (
      <Text size="sm" truncate>
        {url}
      </Text>
    );
  const page = hatchLinkWebUrl(url, window.location.origin, {
    allowLoopbackHttp: true,
  });
  const href = page ?? url;
  const web = /^https?:/i.test(href);
  const here = web && new URL(href).origin === window.location.origin;
  return (
    <Anchor
      href={href}
      {...(web && !here ? { target: '_blank', rel: 'noreferrer' } : {})}
      size="sm"
      truncate
    >
      {url}
    </Anchor>
  );
}
