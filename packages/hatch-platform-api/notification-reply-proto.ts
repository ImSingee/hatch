/**
 * Reply forms and answers in their protobuf form (NotificationService), for
 * the platform API handlers, the CLI and the mobile app.
 */
import { create } from '@bufbuild/protobuf';
import {
  NotificationAnswerOptionsSchema,
  NotificationAnswerSchema,
  NotificationReplyFieldSchema,
  NotificationReplyOptionSchema,
  NotificationReplySchema,
  type NotificationAnswer as NotificationAnswerMessage,
  type NotificationReply as NotificationReplyMessage,
} from './gen/hatch/platform/v1/notification_pb.js';
import {
  DEFAULT_SUBMIT_LABEL,
  DEFAULT_TEXT_MAX_LENGTH,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
  type ReplyOption,
} from './notification-reply';

/**
 * A reply form message as plain sender input, leaving unset fields unset so
 * the sender schema applies its defaults and empty-value rules.
 */
export function replyInputFromMessage(message: NotificationReplyMessage) {
  return {
    fields: message.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      description: field.description,
      required: field.required,
      options: field.options.map((option) => ({
        id: option.id,
        label: option.label,
        destructive: option.destructive || undefined,
        primary: option.primary || undefined,
        note: option.note,
        badge: option.badge,
      })),
      default:
        field.defaults.length === 0
          ? undefined
          : field.type === 'multiple'
            ? field.defaults
            : field.defaults.length === 1
              ? field.defaults[0]
              : field.defaults,
      minSelected: field.minSelected,
      maxSelected: field.maxSelected,
      placeholder: field.placeholder,
      multiline: field.multiline,
      maxLength: field.maxLength,
    })),
    submitLabel: message.submitLabel,
  };
}

/** A normalized reply form as read APIs return it. */
export function replyFromMessage(message: NotificationReplyMessage): ReplyForm {
  return {
    submitLabel: message.submitLabel || DEFAULT_SUBMIT_LABEL,
    fields: message.fields.map((field): ReplyField => {
      const base = {
        id: field.id,
        label: field.label,
        ...(field.description ? { description: field.description } : {}),
        required: field.required ?? true,
      };
      const options = field.options.map((option): ReplyOption => ({
        id: option.id,
        label: option.label,
        ...(option.destructive ? { destructive: true as const } : {}),
        ...(option.primary ? { primary: true as const } : {}),
        ...(option.note ? { note: option.note } : {}),
        ...(option.badge ? { badge: option.badge } : {}),
      }));
      switch (field.type) {
        case 'text':
          return {
            ...base,
            type: 'text',
            ...(field.placeholder ? { placeholder: field.placeholder } : {}),
            multiline: field.multiline ?? false,
            maxLength: field.maxLength || DEFAULT_TEXT_MAX_LENGTH,
          };
        case 'multiple':
          return {
            ...base,
            type: 'multiple',
            options,
            minSelected: field.minSelected || 1,
            maxSelected: field.maxSelected || options.length,
            ...(field.defaults.length > 0 ? { default: field.defaults } : {}),
          };
        default:
          return {
            ...base,
            type: field.type === 'buttons' ? 'buttons' : 'single',
            options,
            ...(field.type === 'single' && field.defaults[0]
              ? { default: field.defaults[0] }
              : {}),
          };
      }
    }),
  };
}

export function replyToMessage(reply: ReplyForm): NotificationReplyMessage {
  return create(NotificationReplySchema, {
    submitLabel: reply.submitLabel,
    fields: reply.fields.map((field) =>
      create(NotificationReplyFieldSchema, {
        id: field.id,
        type: field.type,
        label: field.label,
        description: field.description,
        required: field.required,
        options:
          field.type === 'text'
            ? []
            : field.options.map((option) =>
                create(NotificationReplyOptionSchema, {
                  id: option.id,
                  label: option.label,
                  destructive: option.destructive === true,
                  primary: option.primary === true,
                  note: option.note,
                  badge: option.badge,
                }),
              ),
        defaults:
          field.type === 'multiple'
            ? (field.default ?? [])
            : field.type === 'single' && field.default
              ? [field.default]
              : [],
        ...(field.type === 'multiple'
          ? { minSelected: field.minSelected, maxSelected: field.maxSelected }
          : {}),
        ...(field.type === 'text'
          ? {
              placeholder: field.placeholder,
              multiline: field.multiline,
              maxLength: field.maxLength,
            }
          : {}),
      }),
    ),
  });
}

export function answersToMessages(
  answers: ReplyAnswers,
): Record<string, NotificationAnswerMessage> {
  return Object.fromEntries(
    Object.entries(answers).map(([fieldId, answer]) => [
      fieldId,
      create(NotificationAnswerSchema, {
        answer: Array.isArray(answer)
          ? {
              case: 'optionIds',
              value: create(NotificationAnswerOptionsSchema, { ids: answer }),
            }
          : { case: 'value', value: answer },
      }),
    ]),
  );
}

/** Answer messages as plain answers; an empty message is left out. */
export function answersFromMessages(
  messages: Record<string, NotificationAnswerMessage>,
): ReplyAnswers {
  const answers: ReplyAnswers = {};
  for (const [fieldId, message] of Object.entries(messages)) {
    if (message.answer.case === 'value')
      answers[fieldId] = message.answer.value;
    else if (message.answer.case === 'optionIds') {
      answers[fieldId] = message.answer.value.ids;
    }
  }
  return answers;
}
