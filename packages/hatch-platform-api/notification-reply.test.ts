import { describe, expect, it } from 'vitest';
import {
  defaultAnswers,
  describeAnswers,
  replyPushMode,
  submitsWithButtons,
  validateAnswers,
  type ReplyForm,
} from './notification-reply';
import {
  answersFromMessages,
  answersToMessages,
  replyFromMessage,
  replyToMessage,
} from './notification-reply-proto';
import {
  describeIssue,
  notificationReplySchema,
  optionalReplySchema,
} from './notification-reply-schema';

function issue(input: unknown): string {
  const result = notificationReplySchema.safeParse(input);
  if (result.success) throw new Error('expected the form to be rejected');
  return describeIssue(result.error);
}

const choice = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: `o${index}`,
    label: `Option ${index}`,
  }));

describe('reply form rules', () => {
  it('rejects forms that cannot be shown or answered', () => {
    expect(issue({ fields: [] })).toBe(
      'fields: a reply form needs at least one field',
    );
    expect(
      issue({
        fields: [{ id: 'a', type: 'buttons', label: 'A', options: choice(5) }],
      }),
    ).toBe('fields.0.options: buttons fields need 1-4 options');
    expect(
      issue({
        fields: [{ id: 'a', type: 'single', label: 'A', options: choice(1) }],
      }),
    ).toBe('fields.0.options: single fields need 2-50 options');
    expect(
      issue({
        fields: [
          { id: 'a', type: 'text', label: 'A' },
          { id: 'a', type: 'text', label: 'B' },
        ],
      }),
    ).toBe('fields.1.id: duplicate field id "a"');
    expect(
      issue({
        fields: [
          {
            id: 'a',
            type: 'multiple',
            label: 'A',
            options: choice(3),
            minSelected: 3,
            maxSelected: 2,
          },
        ],
      }),
    ).toBe(
      'fields.0.maxSelected: maxSelected must be between minSelected and the number of options',
    );
    expect(
      issue({
        fields: [{ id: 'a', type: 'text', label: 'A', options: choice(2) }],
      }),
    ).toBe('fields.0.options: options is only allowed on choice fields');
    expect(
      issue({
        fields: [
          {
            id: 'a',
            type: 'single',
            label: 'A',
            options: [
              { id: 'x', label: 'X', destructive: true },
              { id: 'y', label: 'Y' },
            ],
          },
        ],
      }),
    ).toBe(
      'fields.0.options.0.destructive: destructive is only allowed on buttons options',
    );
    expect(
      issue({
        fields: [
          {
            id: 'a',
            type: 'buttons',
            label: 'A',
            options: [{ id: 'x', label: 'x'.repeat(33) }],
          },
        ],
      }),
    ).toBe(
      'fields.0.options.0.label: button labels must be at most 32 characters',
    );
  });

  it('treats every empty spelling of an optional setting as omitted', () => {
    const base = { id: 'note', type: 'text', label: 'Note' };
    const expected = notificationReplySchema.parse({ fields: [base] });
    expect(expected).toEqual({
      submitLabel: 'Submit',
      fields: [{ ...base, required: true, multiline: false, maxLength: 1000 }],
    });
    for (const empty of [null, '', 0, []]) {
      expect(
        notificationReplySchema.parse({
          fields: [
            {
              ...base,
              description: empty,
              placeholder: empty,
              maxLength: empty,
              options: empty,
              minSelected: empty,
            },
          ],
          submitLabel: empty,
        }),
      ).toEqual(expected);
    }
    for (const empty of [undefined, null, '', {}]) {
      expect(optionalReplySchema.parse(empty)).toBeNull();
    }
  });
});

const form: ReplyForm = notificationReplySchema.parse({
  fields: [
    { id: 'when', type: 'single', label: 'When', options: choice(3) },
    {
      id: 'who',
      type: 'multiple',
      label: 'Who',
      options: choice(4),
      maxSelected: 2,
      required: false,
    },
    { id: 'note', type: 'text', label: 'Note', maxLength: 5, required: false },
  ],
});

describe('answers', () => {
  it('normalizes valid answers and drops unanswered optional fields', () => {
    expect(
      validateAnswers(form, { when: 'o1', who: ['o2', 'o0'], note: '  hi ' }),
    ).toEqual({ when: 'o1', who: ['o0', 'o2'], note: 'hi' });
    expect(validateAnswers(form, { when: 'o0', who: [], note: '' })).toEqual({
      when: 'o0',
    });
  });

  it('never reads an unanswered field through the object prototype', () => {
    const tricky = notificationReplySchema.parse({
      fields: [
        { id: 'constructor', type: 'text', label: 'Note', required: false },
        {
          id: 'tostring',
          type: 'multiple',
          label: 'Tags',
          options: choice(2),
          required: false,
        },
      ],
    });
    expect(validateAnswers(tricky, {})).toEqual({});
    expect(describeAnswers(tricky, {})).toEqual([]);
  });

  it('names the field of an answer that does not fit', () => {
    const reject = (answers: unknown) => () => validateAnswers(form, answers);
    expect(reject({})).toThrow('answers.when: is required');
    expect(reject({ when: 'zz' })).toThrow('answers.when: unknown option "zz"');
    expect(reject({ when: ['o1'] })).toThrow(
      'answers.when: must be one option id',
    );
    expect(reject({ when: 'o1', who: ['o0', 'o1', 'o2'] })).toThrow(
      'answers.who: select 1-2 options',
    );
    expect(reject({ when: 'o1', who: ['o0', 'o0'] })).toThrow(
      'answers.who: lists an option twice',
    );
    expect(reject({ when: 'o1', note: 'too long' })).toThrow(
      'answers.note: must be at most 5 characters',
    );
    expect(reject({ when: 'o1', other: 'x' })).toThrow(
      'answers.other: unknown field',
    );
    expect(reject([])).toThrow('answers must be an object keyed by field id');
  });

  it('survives the protobuf round trip', () => {
    expect(replyFromMessage(replyToMessage(form))).toEqual(form);
    const answers = { when: 'o1', who: ['o0', 'o2'], note: 'hi' };
    expect(answersFromMessages(answersToMessages(answers))).toEqual(answers);
  });

  it('answers from the push only for one required buttons or text field', () => {
    const one = (field: Record<string, unknown>) =>
      replyPushMode(notificationReplySchema.parse({ fields: [field] }));
    expect(
      one({ id: 'a', type: 'buttons', label: 'A', options: choice(2) }),
    ).toBe('buttons');
    expect(one({ id: 'a', type: 'text', label: 'A' })).toBe('text');
    expect(one({ id: 'a', type: 'text', label: 'A', required: false })).toBe(
      'form',
    );
    expect(
      one({ id: 'a', type: 'single', label: 'A', options: choice(2) }),
    ).toBe('form');
    expect(replyPushMode(form)).toBe('form');
  });
});

describe('form additions', () => {
  it('keep primary, notes, badges and defaults where they apply', () => {
    const form = notificationReplySchema.parse({
      fields: [
        {
          id: 'pick',
          type: 'multiple',
          label: 'Upgrade',
          default: ['zod', 'vitest'],
          options: [
            { id: 'vitest', label: 'vitest', badge: 'patch' },
            { id: 'zod', label: 'zod', note: 'tested' },
            { id: 'drizzle', label: 'drizzle-orm', badge: 'breaking' },
          ],
        },
        {
          id: 'go',
          type: 'buttons',
          options: [
            { id: 'yes', label: 'Upgrade', primary: true },
            { id: 'no', label: 'Skip' },
          ],
        },
      ],
    });
    expect(form.fields[0]).toMatchObject({
      // Kept in option order, like answers.
      default: ['vitest', 'zod'],
      options: [
        { id: 'vitest', label: 'vitest', badge: 'patch' },
        { id: 'zod', label: 'zod', note: 'tested' },
        { id: 'drizzle', label: 'drizzle-orm', badge: 'breaking' },
      ],
    });
    expect(form.fields[1]).toMatchObject({
      label: '',
      options: [{ id: 'yes', label: 'Upgrade', primary: true }, { id: 'no' }],
    });
    expect(submitsWithButtons(form)).toBe(true);
    expect(defaultAnswers(form)).toEqual({ pick: ['vitest', 'zod'] });
    expect(replyFromMessage(replyToMessage(form))).toEqual(form);
  });

  it('reject additions on the wrong kind of field', () => {
    const issue = (field: Record<string, unknown>) =>
      describeIssue(
        notificationReplySchema.safeParse({ fields: [field] }).error!,
        'reply',
      );
    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    expect(
      issue({
        id: 'q',
        type: 'single',
        label: 'Q',
        options,
        default: ['a', 'b'],
      }),
    ).toBe('reply.fields.0.default: a single field has one default option');
    expect(
      issue({ id: 'q', type: 'single', label: 'Q', options, default: 'c' }),
    ).toBe('reply.fields.0.default: default names unknown option "c"');
    expect(
      issue({
        id: 'q',
        type: 'single',
        label: 'Q',
        options: [{ id: 'a', label: 'A', primary: true }, options[1]],
      }),
    ).toBe(
      'reply.fields.0.options.0.primary: primary is only allowed on buttons options',
    );
    expect(
      issue({
        id: 'q',
        type: 'buttons',
        options: [{ id: 'a', label: 'A', note: 'x' }],
      }),
    ).toBe(
      'reply.fields.0.options.0.note: note is only allowed on single and multiple options',
    );
    expect(issue({ id: 'q', type: 'text' })).toBe(
      'reply.fields.0.label: label is required',
    );
  });
});
