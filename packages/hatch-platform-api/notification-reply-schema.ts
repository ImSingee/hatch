/**
 * Sender-side validation of reply forms, shared by the platform (App and
 * Channel pushes) and the CLI (local validation before any RPC), so both
 * reject the same input with the same messages. This schema checks types and
 * text; the form's own rules are `normalizeReplyForm`'s.
 *
 * Empty values (`null`, `""`, `[]`, `0`) behave exactly like an omitted
 * optional field.
 */
import { z } from 'zod';
import {
  MAX_FIELD_DESCRIPTION,
  MAX_FIELD_LABEL,
  MAX_OPTION_BADGE,
  MAX_OPTION_LABEL,
  MAX_OPTION_NOTE,
  MAX_PLACEHOLDER,
  MAX_REPLY_FIELDS,
  MAX_SUBMIT_LABEL,
  REPLY_FIELD_ID_RE,
  REPLY_FIELD_TYPES,
  REPLY_OPTION_ID_RE,
  type ReplyForm,
} from './notification-reply';
import {
  normalizeReplyForm,
  type ReplyFieldInput,
} from './notification-reply-form';

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0);

/** Treat every empty spelling as omitted before validating the value. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (isEmpty(value) ? undefined : value),
    schema.optional(),
  );

const trimmedText = (max: number, label: string) =>
  z
    .string({ error: `${label} must be a string` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

const optionInput = z
  .object({
    id: z
      .string({ error: 'option id must be a string' })
      .regex(
        REPLY_OPTION_ID_RE,
        'option id must be 1-40 lowercase letters, digits, "_", "-" or "."',
      ),
    label: trimmedText(MAX_OPTION_LABEL, 'option label'),
    destructive: optional(z.boolean()),
    primary: optional(z.boolean()),
    note: optional(trimmedText(MAX_OPTION_NOTE, 'option note')),
    badge: optional(trimmedText(MAX_OPTION_BADGE, 'option badge')),
  })
  .strict();

const fieldInput: z.ZodType<ReplyFieldInput> = z
  .object({
    id: z
      .string({ error: 'field id must be a string' })
      .regex(
        REPLY_FIELD_ID_RE,
        'field id must start with a lowercase letter and use at most 40 lowercase letters, digits or "_"',
      ),
    type: z.enum(REPLY_FIELD_TYPES, {
      error: 'type must be one of buttons, single, multiple, text',
    }),
    // Required except on buttons fields, checked with the type below.
    label: optional(trimmedText(MAX_FIELD_LABEL, 'label')),
    description: optional(trimmedText(MAX_FIELD_DESCRIPTION, 'description')),
    required: z.preprocess(
      (value) => (value === null || value === undefined ? undefined : value),
      z.boolean({ error: 'required must be a boolean' }).optional(),
    ),
    options: optional(z.array(optionInput)),
    minSelected: optional(z.number().int()),
    maxSelected: optional(z.number().int()),
    placeholder: optional(trimmedText(MAX_PLACEHOLDER, 'placeholder')),
    multiline: z.preprocess(
      (value) => (value === null || value === undefined ? undefined : value),
      z.boolean({ error: 'multiline must be a boolean' }).optional(),
    ),
    maxLength: optional(z.number().int()),
    /** single: one option id; multiple: a list of them. */
    default: optional(
      z.union([z.string(), z.array(z.string())], {
        error: 'default must be an option id or a list of option ids',
      }),
    ),
  })
  .strict();

/**
 * A reply form as accepted from senders. Each issue's path names the field
 * to fix, for example `fields.0.options`.
 */
export const notificationReplySchema = z
  .object({
    fields: z
      .array(fieldInput, { error: 'fields must be a list' })
      .min(1, 'a reply form needs at least one field')
      .max(
        MAX_REPLY_FIELDS,
        `a reply form has at most ${MAX_REPLY_FIELDS} fields`,
      ),
    submitLabel: optional(trimmedText(MAX_SUBMIT_LABEL, 'submitLabel')),
  })
  .strict()
  .transform((input, ctx): ReplyForm => {
    const { form, issues } = normalizeReplyForm(input);
    for (const issue of issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
    return form;
  });

/** `reply` as an optional push field: empty spellings mean no form. */
export const optionalReplySchema = z.preprocess(
  (value) =>
    value === null ||
    value === undefined ||
    value === '' ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
      ? null
      : value,
  notificationReplySchema.nullable(),
);

/** First issue as `path: message`, for one-line error responses. */
export function describeIssue(error: z.ZodError, prefix?: string): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
