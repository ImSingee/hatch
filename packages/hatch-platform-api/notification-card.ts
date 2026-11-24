/**
 * Notification cards: what a notification shows besides its title and body in
 * the timeline. A status (a short label with a tone) and at most one block (a
 * progress bar, up to three figures, or a quoted comment). Phones and webhooks
 * keep showing the title and body, so a card only adds to them. Types and
 * limits shared by the platform, the CLI and the mobile app, with no
 * dependencies; the zod schema lives in `notification-card-schema`.
 */

export const MAX_CARD_STATUS_LABEL = 24;
export const MAX_CARD_LABEL = 40;
export const MAX_CARD_VALUE = 24;
export const MAX_CARD_QUOTE = 500;
export const MAX_CARD_STATS = 3;

export type NotificationCardTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';
export const NOTIFICATION_CARD_TONES = [
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
] as const satisfies readonly NotificationCardTone[];

export type NotificationCardStatus = {
  label: string;
  tone: NotificationCardTone;
};

/** A bar filled to `percent` (0–100), with an optional value such as "3 / 14". */
export type NotificationCardProgress = {
  type: 'progress';
  label: string;
  percent: number;
  value?: string;
};

/** One to three figures side by side, such as "¥3,482 · spent". */
export type NotificationCardStats = {
  type: 'stats';
  items: { value: string; label: string }[];
};

/** A comment someone made, such as a review note. */
export type NotificationCardQuote = {
  type: 'quote';
  author: string;
  text: string;
  /** Where it was said, such as "idle-shutdown.ts:142". */
  location?: string;
};

export type NotificationCardBlock =
  | NotificationCardProgress
  | NotificationCardStats
  | NotificationCardQuote;

/** Stored cards are normalized: empty parts are left out. */
export type NotificationCard = {
  status?: NotificationCardStatus;
  block?: NotificationCardBlock;
};
