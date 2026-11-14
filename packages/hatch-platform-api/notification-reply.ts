/**
 * Notification reply forms: the questions a notification asks and the answers
 * a person gives. Types and answer rules shared by the platform, the CLI and
 * the mobile app, with no dependencies so the web and phone bundles stay
 * small. The sender-side schema lives in `notification-reply-schema` (it
 * needs zod, which the mobile app does not bundle) and the protobuf mapping in
 * `notification-reply-proto`.
 *
 * Stored forms are normalized: every default is filled in, so receivers never
 * apply defaults of their own.
 */

export const MAX_REPLY_FIELDS = 10;
export const MAX_REPLY_BYTES = 16 * 1024;
export const MAX_BUTTON_OPTIONS = 4;
export const MAX_CHOICE_OPTIONS = 50;
export const MAX_BUTTON_LABEL = 32;
export const MAX_OPTION_LABEL = 100;
export const MAX_FIELD_LABEL = 100;
export const MAX_FIELD_DESCRIPTION = 300;
export const MAX_SUBMIT_LABEL = 32;
export const MAX_PLACEHOLDER = 100;
export const DEFAULT_TEXT_MAX_LENGTH = 1000;
export const MAX_TEXT_LENGTH = 4000;
export const DEFAULT_SUBMIT_LABEL = 'Submit';

export const REPLY_FIELD_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const REPLY_OPTION_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export type ReplyFieldType = 'buttons' | 'single' | 'multiple' | 'text';
export const REPLY_FIELD_TYPES = [
  'buttons',
  'single',
  'multiple',
  'text',
] as const satisfies readonly ReplyFieldType[];

export type ReplyOption = {
  id: string;
  label: string;
  /** Buttons only: shown as a destructive action. */
  destructive?: true;
};

type FieldBase = {
  id: string;
  label: string;
  description?: string;
  /** A required field must be answered before the form can be submitted. */
  required: boolean;
};

/** `buttons` is a single choice shown as buttons. */
export type ReplyChoiceField = FieldBase & {
  type: 'buttons' | 'single';
  options: ReplyOption[];
};

export type ReplyMultipleField = FieldBase & {
  type: 'multiple';
  options: ReplyOption[];
  /** At least this many options when answered (1 or more). */
  minSelected: number;
  maxSelected: number;
};

export type ReplyTextField = FieldBase & {
  type: 'text';
  placeholder?: string;
  multiline: boolean;
  maxLength: number;
};

export type ReplyField = ReplyChoiceField | ReplyMultipleField | ReplyTextField;

/** A normalized reply form, as stored and sent to every reader. */
export type ReplyForm = {
  fields: ReplyField[];
  submitLabel: string;
};

/**
 * Answers keyed by field id: an option id for `buttons` and `single`, a list
 * of option ids for `multiple`, the text for `text`. Unanswered optional
 * fields are absent.
 */
export type ReplyAnswers = Record<string, string | string[]>;

export class ReplyAnswerError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(field ? `answers.${field}: ${message}` : message);
    this.name = 'ReplyAnswerError';
    this.field = field;
  }
}

/**
 * Check answers against the form and return them normalized: text trimmed,
 * unanswered optional fields dropped. Throws `ReplyAnswerError` naming the
 * field to fix.
 */
export function validateAnswers(
  reply: ReplyForm,
  answers: unknown,
): ReplyAnswers {
  if (
    answers === null ||
    typeof answers !== 'object' ||
    Array.isArray(answers)
  ) {
    throw new ReplyAnswerError('answers must be an object keyed by field id');
  }
  const input = answers as Record<string, unknown>;
  const fields = new Map(reply.fields.map((field) => [field.id, field]));
  for (const key of Object.keys(input)) {
    if (!fields.has(key)) throw new ReplyAnswerError('unknown field', key);
  }
  const result: ReplyAnswers = {};
  for (const field of reply.fields) {
    const raw = input[field.id];
    if (field.type === 'text') {
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        throw new ReplyAnswerError('must be text', field.id);
      }
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (!text) {
        if (field.required) throw new ReplyAnswerError('is required', field.id);
        continue;
      }
      if (Array.from(text).length > field.maxLength) {
        throw new ReplyAnswerError(
          `must be at most ${field.maxLength} characters`,
          field.id,
        );
      }
      result[field.id] = text;
      continue;
    }

    const optionIds = new Set(field.options.map((option) => option.id));
    if (field.type === 'multiple') {
      const list =
        raw === undefined || raw === null
          ? []
          : typeof raw === 'string'
            ? [raw]
            : raw;
      if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
        throw new ReplyAnswerError('must be a list of option ids', field.id);
      }
      const ids = list as string[];
      if (new Set(ids).size !== ids.length) {
        throw new ReplyAnswerError('lists an option twice', field.id);
      }
      const unknown = ids.find((id) => !optionIds.has(id));
      if (unknown !== undefined) {
        throw new ReplyAnswerError(`unknown option "${unknown}"`, field.id);
      }
      if (ids.length === 0) {
        if (field.required) throw new ReplyAnswerError('is required', field.id);
        continue;
      }
      if (ids.length < field.minSelected || ids.length > field.maxSelected) {
        throw new ReplyAnswerError(
          field.minSelected === field.maxSelected
            ? `select exactly ${field.minSelected} options`
            : `select ${field.minSelected}-${field.maxSelected} options`,
          field.id,
        );
      }
      // Keep the form's option order, so equal answers compare equal.
      result[field.id] = field.options
        .map((option) => option.id)
        .filter((id) => ids.includes(id));
      continue;
    }

    if (raw === undefined || raw === null || raw === '') {
      if (field.required) throw new ReplyAnswerError('is required', field.id);
      continue;
    }
    if (typeof raw !== 'string') {
      throw new ReplyAnswerError('must be one option id', field.id);
    }
    if (!optionIds.has(raw)) {
      throw new ReplyAnswerError(`unknown option "${raw}"`, field.id);
    }
    result[field.id] = raw;
  }
  return result;
}

/**
 * How a phone can answer from the notification itself: tap one of the
 * buttons, type into the system reply box, or open the form in the app.
 */
export type ReplyPushMode = 'buttons' | 'text' | 'form';

export function replyPushMode(reply: ReplyForm): ReplyPushMode {
  if (reply.fields.length !== 1) return 'form';
  const [field] = reply.fields;
  if (field!.type === 'buttons' && field!.required) return 'buttons';
  if (field!.type === 'text' && field!.required) return 'text';
  return 'form';
}

/** One answered field with the option labels resolved. */
export type AnswerLine = { fieldId: string; label: string; value: string };

export function describeAnswers(
  reply: ReplyForm,
  answers: ReplyAnswers,
): AnswerLine[] {
  const lines: AnswerLine[] = [];
  for (const field of reply.fields) {
    const answer = answers[field.id];
    if (answer === undefined) continue;
    let value: string;
    if (field.type === 'text') {
      value = String(answer);
    } else {
      const labels = new Map(
        field.options.map((option) => [option.id, option.label]),
      );
      const ids = Array.isArray(answer) ? answer : [answer];
      value = ids.map((id) => labels.get(id) ?? id).join(', ');
    }
    lines.push({ fieldId: field.id, label: field.label, value });
  }
  return lines;
}

/**
 * Short one-line summary: the bare answer for a one-field form, otherwise
 * `Label: value; …`.
 */
export function summarizeAnswers(
  reply: ReplyForm,
  answers: ReplyAnswers,
): string {
  const lines = describeAnswers(reply, answers);
  if (reply.fields.length === 1) return lines[0]?.value ?? '';
  return lines.map((line) => `${line.label}: ${line.value}`).join('; ');
}
