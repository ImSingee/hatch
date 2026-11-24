/**
 * Notification cards in their protobuf form (NotificationService), for the
 * platform API handlers, the CLI and the mobile app.
 */
import { create } from '@bufbuild/protobuf';
import {
  NotificationCardSchema,
  type NotificationCard as NotificationCardMessage,
} from './gen/hatch/platform/v1/notification_pb.js';
import type { NotificationCard } from './notification-card';

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
