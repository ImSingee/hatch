/**
 * Shared display formatting helpers. Importing this module also registers the
 * dayjs relativeTime plugin, so callers never need their own `dayjs.extend`.
 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

type DateInput = string | number | Date | null | undefined;

/** "3 minutes ago"-style relative timestamp. */
export function formatRelative(date: DateInput): string {
  return dayjs(date).fromNow();
}

/**
 * Relative timestamp in the viewer's language ("3 minutes ago", "3 分钟前").
 * Unit thresholds follow dayjs `fromNow()` so values match the English-only
 * `formatRelative`.
 */
export function formatRelativeTime(
  date: DateInput,
  locale: string,
  now: number = Date.now(),
): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  const diff = dayjs(date).valueOf() - now;
  const sign = diff < 0 ? -1 : 1;
  const seconds = Math.abs(diff) / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30.4375;
  const at = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    rtf.format(sign * Math.max(1, Math.round(value)), unit);
  if (seconds < 45) return at(seconds, 'second');
  if (seconds < 90) return at(1, 'minute');
  if (minutes < 45) return at(minutes, 'minute');
  if (minutes < 90) return at(1, 'hour');
  if (hours < 22) return at(hours, 'hour');
  if (hours < 36) return at(1, 'day');
  if (days < 26) return at(days, 'day');
  if (days < 46) return at(1, 'month');
  if (months < 11) return at(months, 'month');
  if (months < 18) return at(1, 'year');
  return at(days / 365.25, 'year');
}

/** Exact timestamp for tooltips / detail views. */
export function formatExact(date: DateInput): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ss');
}

/** Compact duration: `340ms`, `4.2s`, `38s`, `2m 05s`-style. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Compact byte size: `812 B`, `3.4 KB`, `1.2 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
