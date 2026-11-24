import { describe, expect, it } from 'vitest';
import {
  coerceSchemaQueryInput,
  validateSchemaInput,
} from './json-schema-input';

/** A JSON Schema like the one generated for an App task input. */
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
    dryRun: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { enum: ['fast', 'slow'] },
  },
  required: ['name'],
  additionalProperties: false,
};

describe('validateSchemaInput', () => {
  it('accepts anything when no schema was captured', () => {
    expect(validateSchemaInput(null, { any: 'thing' })).toEqual({
      success: true,
      data: { any: 'thing' },
    });
    expect(validateSchemaInput(undefined, undefined)).toEqual({
      success: true,
      data: {},
    });
  });

  it('accepts valid input and applies defaults', () => {
    const res = validateSchemaInput(schema, { name: 'job' });
    expect(res).toEqual({ success: true, data: { name: 'job', count: 1 } });
  });

  it('keeps provided optional values and enum members', () => {
    const input = {
      name: 'job',
      count: 5,
      dryRun: true,
      tags: ['a', 'b'],
      mode: 'fast',
    };
    expect(validateSchemaInput(schema, input)).toEqual({
      success: true,
      data: input,
    });
  });

  it('rejects a missing required field with its path in the message', () => {
    expect(validateSchemaInput(schema, {})).toEqual({
      success: false,
      message: expect.stringMatching(/name/),
    });
  });

  it('rejects wrong types and out-of-range numbers', () => {
    expect(validateSchemaInput(schema, { name: 42 }).success).toBe(false);
    expect(validateSchemaInput(schema, { name: 'x', count: 0 }).success).toBe(
      false,
    );
    expect(validateSchemaInput(schema, { name: 'x', count: 2.5 }).success).toBe(
      false,
    );
    expect(
      validateSchemaInput(schema, { name: 'x', mode: 'other' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys when additionalProperties is false', () => {
    expect(validateSchemaInput(schema, { name: 'x', extra: 'nope' })).toEqual({
      success: false,
      message: expect.stringMatching(/extra/),
    });
  });

  it('enforces string patterns', () => {
    const patterned = {
      type: 'object',
      properties: { repo: { type: 'string', pattern: '^[a-z]+/[a-z]+$' } },
    };
    expect(validateSchemaInput(patterned, { repo: 'a/b' }).success).toBe(true);
    expect(validateSchemaInput(patterned, { repo: 'ab' }).success).toBe(false);
  });

  it('keeps unknown keys when additionalProperties is not false', () => {
    const loose = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const res = validateSchemaInput(loose, { name: 'x', extra: 'kept' });
    expect(res).toEqual({ success: true, data: { name: 'x', extra: 'kept' } });
  });

  it('handles nullable unions from type arrays', () => {
    const nullable = {
      type: 'object',
      properties: { note: { type: ['string', 'null'] } },
      required: ['note'],
    };
    expect(validateSchemaInput(nullable, { note: null }).success).toBe(true);
    expect(validateSchemaInput(nullable, { note: 'hi' }).success).toBe(true);
    expect(validateSchemaInput(nullable, { note: 3 }).success).toBe(false);
  });
});

describe('coerceSchemaQueryInput', () => {
  it('coerces numeric and boolean query strings toward the schema', () => {
    const out = coerceSchemaQueryInput(schema, {
      name: 'job',
      count: '3',
      dryRun: 'true',
    });
    expect(out).toEqual({ name: 'job', count: 3, dryRun: true });
  });

  it('leaves non-coercible and unknown fields as strings', () => {
    const out = coerceSchemaQueryInput(schema, {
      count: 'not-a-number',
      dryRun: 'yes',
      unknown: 'kept',
    });
    expect(out).toEqual({
      count: 'not-a-number',
      dryRun: 'yes',
      unknown: 'kept',
    });
  });

  it('coerces homogeneous numeric enums', () => {
    const enumSchema = {
      type: 'object',
      properties: { level: { enum: [1, 2, 3] } },
    };
    expect(coerceSchemaQueryInput(enumSchema, { level: '2' })).toEqual({
      level: 2,
    });
  });

  it('passes through untouched when there is no usable schema', () => {
    expect(coerceSchemaQueryInput(null, { a: '1' })).toEqual({ a: '1' });
  });

  it('bounds a backtracking pattern instead of stalling the process', () => {
    const schema = {
      type: 'object',
      properties: { s: { type: 'string', pattern: '^(a+)+$' } },
    };
    const started = Date.now();
    const result = validateSchemaInput(schema, { s: `${'a'.repeat(40)}b` });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({
      success: false,
      message: expect.stringMatching(
        /s: Checking the pattern .* took too long/,
      ),
    });
    expect(validateSchemaInput(schema, { s: 'aaa' }).success).toBe(true);
  });

  it('requires RFC 3339 date-times', () => {
    const schema = {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
    };
    expect(validateSchemaInput(schema, { at: 'tomorrow' })).toMatchObject({
      success: false,
      message: expect.stringMatching(/at:/),
    });
    expect(
      validateSchemaInput(schema, { at: '2026-11-24T10:00:20.021+08:00' })
        .success,
    ).toBe(true);
  });

  it('shares one pattern time budget across every value of an input', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string', pattern: '^(a+)+$' },
        },
      },
    };
    const started = Date.now();
    const result = validateSchemaInput(schema, {
      items: Array.from({ length: 200 }, () => `${'a'.repeat(40)}b`),
    });
    // 200 runaway values would take 200 timeouts if each had its own.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.success).toBe(false);
  });

  it('refuses an oversized strict input and bounds the failure message', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'array', items: { type: 'integer' } } },
    };
    expect(
      validateSchemaInput(
        schema,
        { n: Array.from({ length: 500_000 }, () => 'x') },
        { strict: true },
      ),
    ).toEqual({ success: false, message: 'Input has more than 10000 values.' });
    const result = validateSchemaInput(
      schema,
      { n: Array.from({ length: 5000 }, () => 'x') },
      { strict: true },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message.length).toBeLessThanOrEqual(4000);
    expect(result.message).toMatch(/and 4980 more issue\(s\)$/);
  });
});
