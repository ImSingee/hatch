import {
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDeviceTablet,
  IconDevices,
} from '@tabler/icons-react';
import type { Locale, useI18n } from '~i18n';

type Translate = ReturnType<typeof useI18n>['t'];

/** Absolute local time for session metadata, as the reader's language writes it. */
export function formatSessionTime(
  iso: string,
  locale: Locale,
  t: Translate,
): string {
  const date = new Date(iso);
  return t('account.sessions.dateTime', {
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date),
    time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date),
  });
}

export type DeviceKind = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export const DEVICE_ICONS = {
  desktop: IconDeviceDesktop,
  mobile: IconDeviceMobile,
  tablet: IconDeviceTablet,
  unknown: IconDevices,
} satisfies Record<DeviceKind, unknown>;

// Order matters: Chromium-based browsers also send `Chrome/`, and most
// browsers also send `Safari/`.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|OPiOS)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:HeadlessChrome|Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

// Order matters: iOS sends `like Mac OS X` and Android sends `Linux`.
const SYSTEMS: [RegExp, string, DeviceKind][] = [
  [/\biPad\b/, 'iPadOS', 'tablet'],
  [/\b(?:iPhone|iPod)\b/, 'iOS', 'mobile'],
  [/\bAndroid\b/, 'Android', 'tablet'],
  [/\bCrOS\b/, 'ChromeOS', 'desktop'],
  [/\bWindows\b/, 'Windows', 'desktop'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS', 'desktop'],
  [/\bLinux\b/, 'Linux', 'desktop'],
];

/** Readable browser/OS summary of a stored User-Agent header. */
export function describeUserAgent(
  userAgent: string | null,
  t: Translate,
): {
  label: string;
  kind: DeviceKind;
} {
  const ua = userAgent?.trim();
  if (!ua)
    return { label: t('account.sessions.unknownDevice'), kind: 'unknown' };

  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua));
  const os = system?.[1];
  // Android phones identify as `Mobile`; Android tablets omit it.
  const kind =
    os === 'Android' && /\bMobile\b/.test(ua)
      ? 'mobile'
      : (system?.[2] ?? 'unknown');

  // Browser and system names are product names and stay untranslated.
  const label =
    browser && os
      ? t('account.sessions.deviceLabel', { browser, os })
      : (browser ?? os);
  if (label) return { label, kind };
  // Non-browser clients (CLIs, scripts) lead with their own product token.
  const product = ua.split(/\s/, 1)[0];
  return {
    label: product.startsWith('Mozilla/')
      ? t('account.sessions.unknownBrowser')
      : product,
    kind,
  };
}
