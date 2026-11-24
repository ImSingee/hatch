import dayjs, { type Dayjs } from 'dayjs';
import type { Locale } from '~i18n';

type UpdatedSession = {
  updatedAt: string;
};

/** What a date group's heading names, formatted at render. */
export type SessionGroupLabel =
  | { kind: 'unknown' | 'today' | 'yesterday' }
  /** A day of the past week, by its weekday name. */
  | { kind: 'weekday'; date: Date }
  /** An older day; the year shows only outside the current year. */
  | { kind: 'date'; date: Date; withYear: boolean };

export type SessionDateGroup<T extends UpdatedSession> = {
  key: string;
  label: SessionGroupLabel;
  sessions: T[];
};

function groupIdentity(
  value: Dayjs,
  today: Dayjs,
): Pick<SessionDateGroup<UpdatedSession>, 'key' | 'label'> {
  if (!value.isValid()) return { key: 'unknown', label: { kind: 'unknown' } };

  const date = value.startOf('day');
  const daysAgo = today.diff(date, 'day');
  if (daysAgo <= 0) {
    return { key: today.format('YYYY-MM-DD'), label: { kind: 'today' } };
  }

  const key = date.format('YYYY-MM-DD');
  if (daysAgo === 1) return { key, label: { kind: 'yesterday' } };
  if (daysAgo < 7) {
    return { key, label: { kind: 'weekday', date: date.toDate() } };
  }
  return {
    key,
    label: {
      kind: 'date',
      date: date.toDate(),
      withYear: date.year() !== today.year(),
    },
  };
}

/** Group the server-sorted session summaries by the viewer's local calendar. */
export function groupSessionsByDate<T extends UpdatedSession>(
  sessions: readonly T[],
  now: Date = new Date(),
): SessionDateGroup<T>[] {
  const today = dayjs(now).startOf('day');
  const groups = new Map<string, SessionDateGroup<T>>();

  for (const session of sessions) {
    const identity = groupIdentity(dayjs(session.updatedAt), today);
    const existing = groups.get(identity.key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(identity.key, { ...identity, sessions: [session] });
    }
  }

  return [...groups.values()];
}

type GroupLabelKey =
  | 'agent.sessions.today'
  | 'agent.sessions.yesterday'
  | 'agent.sessions.unknownDate';

/** A date group's heading in the viewer's language. */
export function formatSessionGroupLabel(
  label: SessionGroupLabel,
  locale: Locale,
  t: (key: GroupLabelKey) => string,
): string {
  switch (label.kind) {
    case 'unknown':
      return t('agent.sessions.unknownDate');
    case 'today':
      return t('agent.sessions.today');
    case 'yesterday':
      return t('agent.sessions.yesterday');
    case 'weekday':
      return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
        label.date,
      );
    case 'date':
      return new Intl.DateTimeFormat(locale, {
        month: 'long',
        day: 'numeric',
        ...(label.withYear ? { year: 'numeric' } : {}),
      }).format(label.date);
  }
}
