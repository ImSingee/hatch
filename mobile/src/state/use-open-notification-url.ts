import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking } from 'react-native';
import { notificationUrlAction } from '../core';
import { errorText } from '../ui/primitives';
import { openSurfaceLink } from './deep-links';
import { allowDevelopmentLoopback, useSession } from './session';

/**
 * Opens a link a notification carries (its own link, or one in its content)
 * when the person taps it: Hatch pages, by address or deep link, open here;
 * other web pages in the browser, and any other scheme in its own app.
 */
export function useOpenNotificationUrl() {
  const { origin } = useSession();
  return (url: string) => {
    if (!origin) return;
    const action = notificationUrlAction(url, origin, {
      allowDevelopmentLoopback,
    });
    if (action.open === 'page') openSurfaceLink(action.link);
    else if (action.open === 'none')
      Alert.alert(
        'Couldn’t open link',
        'This version of Hatch can’t open this page. Update the app and try again.',
      );
    else if (/^https?:/i.test(action.url))
      void WebBrowser.openBrowserAsync(action.url).catch((error: unknown) =>
        Alert.alert('Couldn’t open link', errorText(error)),
      );
    else
      void Linking.openURL(action.url).catch(() =>
        Alert.alert(
          'Couldn’t open link',
          `No app on this device opens “${action.url.split(':')[0]}” links.`,
        ),
      );
  };
}
