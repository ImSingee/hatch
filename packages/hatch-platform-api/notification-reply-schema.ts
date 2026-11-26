/**
 * Sender-side validation of reply forms, shared by the platform (App and
 * Channel pushes) and the CLI (local validation before any RPC), so both
 * reject the same input with the same messages.
 *
 * Empty values (`null`, `""`, `[]`, `0`) behave exactly like an omitted
 * optional field.
 */
import { z } from 'zod';
import {
  DEFAULT_SUBMIT_LABEL,
  DEFAULT_TEXT_MAX_LENGTH,
  MAX_BUTTON_LABEL,
  MAX_BUTTON_OPTIONS,
  MAX_CHOICE_OPTIONS,
  MAX_FIELD_DESCRIPTION,
  MAX_FIELD_LABEL,
  MAX_OPTION_BADGE,
  MAX_OPTION_LABEL,
  MAX_OPTION_NOTE,
  MAX_PLACEHOLDER,
  MAX_REPLY_BYTES,
  MAX_REPLY_FIELDS,
  MAX_SUBMIT_LABEL,
  MAX_TEXT_LENGTH,
  REPLY_FIELD_ID_RE,
  REPLY_FIELD_TYPES,
  REPLY_OPTION_ID_RE,
  type ReplyForm,
  type ReplyField,
  type ReplyOption,
} from './notification-reply';

type FieldBase = Pick<ReplyField, 'id' | 'label' | 'description' | 'required'>;

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

const fieldInput = z
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

type FieldInput = z.output<typeof fieldInput>;

function normalizeField(
  input: FieldInput,
  ctx: z.RefinementCtx,
  index: number,
): ReplyField | null {
  const path = (key: string) => ['fields', index, key];
  const issue = (key: string, message: string) => {
    ctx.addIssue({ code: 'custom', message, path: path(key) });
  };
  if (input.label === undefined && input.type !== 'buttons') {
    issue('label', 'label is required');
    return null;
  }
  const base: FieldBase = {
    id: input.id,
    label: input.label ?? '',
    ...(input.description ? { description: input.description } : {}),
    required: input.required ?? true,
  };
  let valid = true;
  const reject = (key: string, message: string) => {
    issue(key, message);
    valid = false;
  };

  if (input.type === 'text') {
    for (const key of [
      'options',
      'minSelected',
      'maxSelected',
      'default',
    ] as const) {
      if (input[key] !== undefined) {
        reject(key, `${key} is only allowed on choice fields`);
      }
    }
    const maxLength = input.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
    if (maxLength < 1 || maxLength > MAX_TEXT_LENGTH) {
      reject('maxLength', `maxLength must be between 1 and ${MAX_TEXT_LENGTH}`);
    }
    if (!valid) return null;
    return {
      ...base,
      type: 'text',
      ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      multiline: input.multiline ?? false,
      maxLength,
    };
  }

  for (const key of ['placeholder', 'multiline', 'maxLength'] as const) {
    if (input[key] !== undefined) {
      reject(key, `${key} is only allowed on text fields`);
    }
  }
  const options = input.options ?? [];
  const buttons = input.type === 'buttons';
  const [minOptions, maxOptions] = buttons
    ? [1, MAX_BUTTON_OPTIONS]
    : [2, MAX_CHOICE_OPTIONS];
  if (options.length < minOptions || options.length > maxOptions) {
    reject(
      'options',
      `${input.type} fields need ${minOptions}-${maxOptions} options`,
    );
  }
  const seen = new Set<string>();
  options.forEach((option, optionIndex) => {
    const optionPath = ['fields', index, 'options', optionIndex];
    if (seen.has(option.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate option id "${option.id}"`,
        path: [...optionPath, 'id'],
      });
      valid = false;
    }
    seen.add(option.id);
    if (buttons && Array.from(option.label).length > MAX_BUTTON_LABEL) {
      ctx.addIssue({
        code: 'custom',
        message: `button labels must be at most ${MAX_BUTTON_LABEL} characters`,
        path: [...optionPath, 'label'],
      });
      valid = false;
    }
    const misplaced = buttons
      ? (['note', 'badge'] as const)
      : (['destructive', 'primary'] as const);
    for (const key of misplaced) {
      if (option[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: buttons
            ? `${key} is only allowed on single and multiple options`
            : `${key} is only allowed on buttons options`,
          path: [...optionPath, key],
        });
        valid = false;
      }
    }
  });
  const normalizedOptions: ReplyOption[] = options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(buttons && option.destructive ? { destructive: true as const } : {}),
    ...(buttons && option.primary ? { primary: true as const } : {}),
    ...(!buttons && option.note ? { note: option.note } : {}),
    ...(!buttons && option.badge ? { badge: option.badge } : {}),
  }));
  const defaults =
    input.default === undefined
      ? []
      : Array.isArray(input.default)
        ? input.default
        : [input.default];
  const unknownDefault = defaults.find((id) => !seen.has(id));
  if (unknownDefault !== undefined) {
    reject('default', `default names unknown option "${unknownDefault}"`);
  } else if (new Set(defaults).size !== defaults.length) {
    reject('default', 'default lists an option twice');
  }

  if (input.type !== 'multiple') {
    for (const key of ['minSelected', 'maxSelected'] as const) {
      if (input[key] !== undefined) {
        reject(key, `${key} is only allowed on multiple fields`);
      }
    }
    if (buttons && input.default !== undefined) {
      reject(
        'default',
        'default is only allowed on single and multiple fields',
      );
    } else if (defaults.length > 1) {
      reject('default', 'a single field has one default option');
    }
    if (!valid) return null;
    return {
      ...base,
      type: input.type,
      options: normalizedOptions,
      ...(defaults[0] ? { default: defaults[0] } : {}),
    };
  }

  const minSelected = input.minSelected ?? 1;
  const maxSelected = input.maxSelected ?? options.length;
  if (minSelected < 1 || minSelected > options.length) {
    reject(
      'minSelected',
      'minSelected must be between 1 and the number of options',
    );
  } else if (maxSelected < minSelected || maxSelected > options.length) {
    reject(
      'maxSelected',
      'maxSelected must be between minSelected and the number of options',
    );
  }
  if (valid && defaults.length > maxSelected) {
    reject('default', 'default lists more options than maxSelected');
  }
  if (!valid) return null;
  // Kept in the form's option order, like answers.
  const ordered = normalizedOptions
    .map((option) => option.id)
    .filter((id) => defaults.includes(id));
  return {
    ...base,
    type: 'multiple',
    options: normalizedOptions,
    minSelected,
    maxSelected,
    ...(ordered.length > 0 ? { default: ordered } : {}),
  };
}

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
    const seen = new Set<string>();
    const fields: ReplyField[] = [];
    input.fields.forEach((field, index) => {
      if (seen.has(field.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate field id "${field.id}"`,
          path: ['fields', index, 'id'],
        });
      }
      seen.add(field.id);
      const normalized = normalizeField(field, ctx, index);
      if (normalized) fields.push(normalized);
    });
    const reply = {
      fields,
      submitLabel: input.submitLabel ?? DEFAULT_SUBMIT_LABEL,
    };
    if (
      new TextEncoder().encode(JSON.stringify(reply)).length > MAX_REPLY_BYTES
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `reply must serialize to at most ${MAX_REPLY_BYTES} bytes`,
        path: [],
      });
    }
    return reply;
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
