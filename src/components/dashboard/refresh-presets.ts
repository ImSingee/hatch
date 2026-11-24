import type { Locale } from '~i18n';

export {
  REFRESH_PRESETS,
  MAX_REFRESH_SECONDS,
  formatInterval,
  clampRefreshSeconds,
} from '../../../packages/hatch-platform-api/dashboard-refresh';

/**
 * A positive refresh interval as a compact label in the viewer's language,
 * in the largest whole unit ("90s", "5m", "1h" in English). Callers name the
 * disabled interval (0) themselves.
 */
export function formatIntervalLabel(seconds: number, locale: Locale): string {
  const [value, unit] =
    seconds % 3600 === 0
      ? [seconds / 3600, 'hour']
      : seconds % 60 === 0
        ? [seconds / 60, 'minute']
        : [seconds, 'second'];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  }).format(value);
}
