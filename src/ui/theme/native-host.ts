import { useLayoutEffect } from 'react';

/**
 * Pages the native mobile app embeds in a WebView over its own desk ground
 * (the ground shapes are drawn natively). They must not paint a ground of
 * their own, or the WebView covers the native shapes with a flat rectangle.
 */
export const NATIVE_HOST_PATH_PREFIX = '/mobile/';

/**
 * Android's WebView, when transparent, composites translucent content with
 * its alpha applied twice: a panel of 80 % white over the native ground comes
 * out grey. Panels are drawn opaque there (`data-host-platform`); iOS keeps
 * the translucent panels the design asks for.
 */
const ANDROID_WEBVIEW = /Android.*; wv\)/;

/**
 * Marks the document before first paint so a native-host page never flashes
 * the opaque ground. `desk.css` makes the page transparent under the mark.
 */
export const NATIVE_HOST_BOOT_SCRIPT = `try{if(location.pathname.indexOf(${JSON.stringify(NATIVE_HOST_PATH_PREFIX)})===0){var r=document.documentElement;r.dataset.host='native';if(${ANDROID_WEBVIEW}.test(navigator.userAgent))r.dataset.hostPlatform='android'}}catch(e){}`;

/**
 * Keeps the mark for as long as a native-host route is mounted, so it also
 * holds after a client-side navigation and is gone when the route unmounts.
 */
export function useNativeHostDocument() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.host = 'native';
    if (ANDROID_WEBVIEW.test(navigator.userAgent))
      root.dataset.hostPlatform = 'android';
    return () => {
      delete root.dataset.host;
      delete root.dataset.hostPlatform;
    };
  }, []);
}
