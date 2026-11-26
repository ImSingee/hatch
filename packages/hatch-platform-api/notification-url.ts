/**
 * Which links a notification may carry, in its `url` and inside its content.
 * Shared by the platform and the CLI (which checks content offline).
 */
import {
  DEEP_LINK_SCHEME,
  DOCUMENT_URL_SCHEMES,
  parseHatchLink,
} from './deep-link';

/**
 * A notification links to anything a device can open: a web page, another
 * app by its own scheme (`mailto:`, `tel:`, `someapp://…`), or a Hatch page by
 * deep link (`hatch://app/<slug>#/route`), which phones open natively and the
 * web opens on the instance. A `hatch:` link must name a page. Schemes that
 * only run inside the current document (`javascript:`, `data:`, …) open
 * nothing and are rejected. Development loopback instances are accepted in
 * deep links; the phone decides whether it may open them.
 */
export function isNotificationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (DOCUMENT_URL_SCHEMES.has(url.protocol)) return false;
  return (
    url.protocol !== `${DEEP_LINK_SCHEME}:` ||
    parseHatchLink(value, { allowLoopbackHttp: true }) !== null
  );
}

export const NOTIFICATION_URL_RULE =
  'an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link';
