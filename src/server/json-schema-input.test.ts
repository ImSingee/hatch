import { describe, expect, it } from 'vitest';
import {
  coerceSchemaQueryInput,
  validateSchemaInput,
} from './json-schema-input';

/** A JSON Schema like the one zod's toJSONSchema emits for a workflow input. */
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

  it('strips unknown keys when additionalProperties is false', () => {
    const res = validateSchemaInput(schema, { name: 'x', extra: 'nope' });
    expect(res).toEqual({ success: true, data: { name: 'x', count: 1 } });
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
    const result = validateSchemaInput(
      schema,
      { s: `${'a'.repeat(40)}b` },
      { strict: true },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({
      success: false,
      message: expect.stringMatching(
        /s: Checking the pattern .* took too long/,
      ),
    });
    expect(
      validateSchemaInput(schema, { s: 'aaa' }, { strict: true }).success,
    ).toBe(true);
  });

  it('requires RFC 3339 date-times in strict mode only', () => {
    const schema = {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' } },
    };
    expect(
      validateSchemaInput(schema, { at: 'tomorrow' }, { strict: true }),
    ).toMatchObject({ success: false, message: expect.stringMatching(/at:/) });
    expect(
      validateSchemaInput(
        schema,
        { at: '2026-11-24T10:00:20.021+08:00' },
        { strict: true },
      ).success,
    ).toBe(true);
    expect(validateSchemaInput(schema, { at: 'tomorrow' }).success).toBe(true);
  });
});
