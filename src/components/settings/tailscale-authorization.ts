import tokens from '../../../packages/hatch-design-tokens/tokens.json';
/** Translated copy for the placeholder page, in the viewer's language. */
export type TailscaleAuthorizationCopy = {
  lang: string;
  title: string;
  heading: string;
  message: string;
};

/** Reserve a window during the click, before asynchronous enrollment starts. */
export function openTailscaleAuthorization(
  copy: TailscaleAuthorizationCopy,
): Window | null {
  let popup: Window | null;
  try {
    popup = window.open('about:blank', '_blank', 'popup,width=520,height=680');
  } catch {
    return null;
  }
  if (!popup) return null;
  // Keep our handle for navigation, but never give the authorization site an
  // opener that can navigate or inspect the Platform window.
  popup.opener = null;
  const doc = popup.document;
  doc.title = copy.title;
  doc.documentElement.lang = copy.lang;
  const referrer = doc.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  doc.head.append(referrer);
  const main = doc.createElement('main');
  // The popup is a blank document outside the Mantine tree, so it reads the
  // design tokens directly instead of the theme's CSS variables.
  doc.body.style.background = tokens.light.background;
  main.style.cssText = `max-width:28rem;margin:18vh auto;padding:2rem;font:16px/1.6 system-ui,sans-serif;color:${tokens.light.foreground}`;
  const title = doc.createElement('h1');
  title.textContent = copy.heading;
  title.style.cssText = 'font-size:1.5rem;font-weight:800;line-height:1.3';
  const message = doc.createElement('p');
  message.textContent = copy.message;
  main.append(title, message);
  doc.body.replaceChildren(main);
  return popup;
}
