/**
 * Notification cards in their protobuf form (NotificationService), for the
 * platform API handlers, the CLI and the mobile app.
 */
import { create } from '@bufbuild/protobuf';
import {
  NotificationCardSchema,
  type NotificationCard as NotificationCardMessage,
} from './gen/hatch/platform/v1/notification_pb.js';
import {
  NOTIFICATION_CARD_TONES,
  type NotificationCard,
  type NotificationCardTone,
} from './notification-card';

/**
 * A card message as plain input for the card schema, leaving unset parts
 * unset so the schema applies its defaults and empty-value rules.
 */
export function cardInputFromMessage(message: NotificationCardMessage) {
  const block = message.block;
  return {
    status: message.status
      ? {
          label: message.status.label,
          ...(message.status.tone ? { tone: message.status.tone } : {}),
        }
      : undefined,
    block:
      block.case === 'progress'
        ? {
            type: 'progress',
            label: block.value.label,
            percent: block.value.percent,
            value: block.value.value,
          }
        : block.case === 'stats'
          ? {
              type: 'stats',
              items: block.value.items.map((item) => ({
                value: item.value,
                label: item.label,
              })),
            }
          : block.case === 'quote'
            ? {
                type: 'quote',
                author: block.value.author,
                text: block.value.text,
                location: block.value.location,
              }
            : undefined,
  };
}

/** A stored card as a message. */
export function cardToMessage(card: NotificationCard): NotificationCardMessage {
  const block = card.block;
  return create(NotificationCardSchema, {
    status: card.status,
    block: !block
      ? { case: undefined }
      : block.type === 'progress'
        ? {
            case: 'progress',
            value: {
              label: block.label,
              percent: block.percent,
              value: block.value,
            },
          }
        : block.type === 'stats'
          ? { case: 'stats', value: { items: block.items } }
          : {
              case: 'quote',
              value: {
                author: block.author,
                text: block.text,
                location: block.location,
              },
            },
  });
}

/** A card message as a stored card, for readers; null without content. */
export function cardFromMessage(
  message: NotificationCardMessage,
): NotificationCard | null {
  const card: NotificationCard = {};
  if (message.status?.label) {
    const tone = message.status.tone as NotificationCardTone;
    card.status = {
      label: message.status.label,
      tone: (NOTIFICATION_CARD_TONES as readonly string[]).includes(tone)
        ? tone
        : 'neutral',
    };
  }
  const block = message.block;
  if (block.case === 'progress') {
    card.block = {
      type: 'progress',
      label: block.value.label,
      // The platform always sends it.
      percent: block.value.percent ?? 0,
      ...(block.value.value ? { value: block.value.value } : {}),
    };
  } else if (block.case === 'stats') {
    card.block = {
      type: 'stats',
      items: block.value.items.map((item) => ({
        value: item.value,
        label: item.label,
      })),
    };
  } else if (block.case === 'quote') {
    card.block = {
      type: 'quote',
      author: block.value.author,
      text: block.value.text,
      ...(block.value.location ? { location: block.value.location } : {}),
    };
  }
  return card.status || card.block ? card : null;
}
