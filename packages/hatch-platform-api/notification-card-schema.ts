/**
 * Validation for notification cards (`notification-card.ts`): the platform
 * normalizes with it and the CLI checks input with it before sending.
 * Empty values (`null`, `""`, `{}`) mean "left out" everywhere.
 */
import { z } from 'zod';
import {
  MAX_CARD_LABEL,
  MAX_CARD_QUOTE,
  MAX_CARD_STATS,
  MAX_CARD_STATUS_LABEL,
  MAX_CARD_VALUE,
  NOTIFICATION_CARD_TONES,
  type NotificationCard,
} from './notification-card';

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0);

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (isEmpty(value) ? undefined : value),
    schema.optional(),
  );

// The limit counts the text as sent, like the Protobuf rules, so both accept
// the same values; surrounding spaces are then dropped.
const text = (max: number) => z.string().max(max).trim().min(1);

const statusSchema = z
  .object({
    label: text(MAX_CARD_STATUS_LABEL),
    tone: z.enum(NOTIFICATION_CARD_TONES).default('neutral'),
  })
  .strict();

const blockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('progress'),
      label: text(MAX_CARD_LABEL),
      percent: z.number().min(0).max(100),
      value: emptyToUndefined(text(MAX_CARD_VALUE)),
    })
    .strict(),
  z
    .object({
      type: z.literal('stats'),
      items: z
        .array(
          z
            .object({
              value: text(MAX_CARD_VALUE),
              label: text(MAX_CARD_LABEL),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_CARD_STATS),
    })
    .strict(),
  z
    .object({
      type: z.literal('quote'),
      author: text(MAX_CARD_LABEL),
      text: text(MAX_CARD_QUOTE),
      location: emptyToUndefined(text(MAX_CARD_LABEL * 2)),
    })
    .strict(),
]);

export const notificationCardSchema = z
  .object({
    status: emptyToUndefined(statusSchema),
    block: emptyToUndefined(blockSchema),
  })
  .strict()
  .transform((card): NotificationCard | null => {
    const out: NotificationCard = {};
    if (card.status) out.status = card.status;
    if (card.block) {
      out.block = Object.fromEntries(
        Object.entries(card.block).filter(([, value]) => value !== undefined),
      ) as NotificationCard['block'];
    }
    return out.status || out.block ? out : null;
  });

/** `card` as an optional field: empty spellings mean no card. */
export const optionalCardSchema = z.preprocess(
  (value) => (isEmpty(value) ? null : value),
  notificationCardSchema.nullable(),
);
