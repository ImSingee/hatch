/**
 * The rules a reply form is held to once its values have the right types:
 * defaults filled in, options counted, ids unique, defaults and selection
 * bounds checked, its size limited. No dependencies, so the platform's
 * sender schema (`notification-reply-schema`, which checks types and text
 * first) and the card compiler (whose inline inputs are already typed by the
 * component catalog) share them.
 */
import {
  DEFAULT_SUBMIT_LABEL,
  DEFAULT_TEXT_MAX_LENGTH,
  MAX_BUTTON_LABEL,
  MAX_BUTTON_OPTIONS,
  MAX_CHOICE_OPTIONS,
  MAX_REPLY_BYTES,
  MAX_REPLY_FIELDS,
  MAX_TEXT_LENGTH,
  type ReplyField,
  type ReplyFieldType,
  type ReplyForm,
  type ReplyOption,
} from './notification-reply';

/** An option as given, its text trimmed and empty values left out. */
export type ReplyOptionInput = {
  id: string;
  label: string;
  destructive?: boolean;
  primary?: boolean;
  note?: string;
  badge?: string;
};

/** A field as given, its text trimmed and empty values left out. */
export type ReplyFieldInput = {
  id: string;
  type: ReplyFieldType;
  label?: string;
  description?: string;
  required?: boolean;
  options?: ReplyOptionInput[];
  minSelected?: number;
  maxSelected?: number;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  /** single: one option id; multiple: a list of them. */
  default?: string | string[];
};

export type ReplyFormInput = {
  fields: ReplyFieldInput[];
  submitLabel?: string;
};

/** A rule the form breaks; `path` names what to fix (`fields.0.options`). */
export type ReplyFormIssue = {
  path: (string | number)[];
  message: string;
};

type FieldBase = Pick<ReplyField, 'id' | 'label' | 'description' | 'required'>;

function normalizeField(
  input: ReplyFieldInput,
  index: number,
  issues: ReplyFormIssue[],
): ReplyField | null {
  const issue = (key: string, message: string) => {
    issues.push({ message, path: ['fields', index, key] });
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
      issues.push({
        message: `duplicate option id "${option.id}"`,
        path: [...optionPath, 'id'],
      });
      valid = false;
    }
    seen.add(option.id);
    if (buttons && Array.from(option.label).length > MAX_BUTTON_LABEL) {
      issues.push({
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
        issues.push({
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
 * A reply form held to its rules: the form with every default filled in,
 * and the rules it breaks (none when it is valid). A form without fields, or
 * with too many, is judged on that alone.
 */
export function normalizeReplyForm(input: ReplyFormInput): {
  form: ReplyForm;
  issues: ReplyFormIssue[];
} {
  const issues: ReplyFormIssue[] = [];
  const submitLabel = input.submitLabel ?? DEFAULT_SUBMIT_LABEL;
  if (input.fields.length < 1 || input.fields.length > MAX_REPLY_FIELDS) {
    issues.push({
      message:
        input.fields.length < 1
          ? 'a reply form needs at least one field'
          : `a reply form has at most ${MAX_REPLY_FIELDS} fields`,
      path: ['fields'],
    });
    return { form: { fields: [], submitLabel }, issues };
  }
  const seen = new Set<string>();
  const fields: ReplyField[] = [];
  input.fields.forEach((field, index) => {
    if (seen.has(field.id)) {
      issues.push({
        message: `duplicate field id "${field.id}"`,
        path: ['fields', index, 'id'],
      });
    }
    seen.add(field.id);
    const normalized = normalizeField(field, index, issues);
    if (normalized) fields.push(normalized);
  });
  const form = { fields, submitLabel };
  if (new TextEncoder().encode(JSON.stringify(form)).length > MAX_REPLY_BYTES) {
    issues.push({
      message: `reply must serialize to at most ${MAX_REPLY_BYTES} bytes`,
      path: [],
    });
  }
  return { form, issues };
}
