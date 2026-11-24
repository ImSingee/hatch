import { describe, expect, it } from 'vitest';
import { optionalCardSchema } from './notification-card-schema';

const parse = (value: unknown) => optionalCardSchema.safeParse(value);

describe('notification cards', () => {
  it('treat every empty spelling as no card, and leave out empty parts', () => {
    for (const empty of [
      null,
      undefined,
      '',
      {},
      { status: null, block: {} },
    ]) {
      expect(parse(empty)).toMatchObject({ success: true, data: null });
    }
    expect(
      parse({
        status: { label: ' CI failed ' },
        block: { type: 'progress', label: 'Checks', percent: 21, value: '' },
      }).data,
    ).toEqual({
      status: { label: 'CI failed', tone: 'neutral' },
      block: { type: 'progress', label: 'Checks', percent: 21 },
    });
  });

  it('reject blocks that cannot be shown and fields that do not belong', () => {
    const invalid = [
      { block: { type: 'progress', label: 'Checks', percent: 120 } },
      {
        block: {
          type: 'stats',
          items: [1, 2, 3, 4].map((n) => ({ value: String(n), label: 'n' })),
        },
      },
      { block: { type: 'chart', label: 'x' } },
      { status: { label: 'Done', tone: 'purple' } },
      { status: { label: 'Done' }, color: 'red' },
    ];
    for (const card of invalid) expect(parse(card).success).toBe(false);
  });
});
