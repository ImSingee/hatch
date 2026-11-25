import type { AgentTool } from '@earendil-works/pi-agent-core';
import { validateToolArguments, type JsonObject } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { text, tool } from './shared';
import { createWebTools } from './web';

/**
 * The shared `tool()` boundary every Agent tool goes through. A model may
 * spell an omitted optional field as null, "", [], {} or 0; each must behave
 * exactly like omission, while required data, explicit false and nonempty
 * wrong types keep strict validation.
 */
const EMPTY_SPELLINGS = [null, '', [], {}, 0] as const;

function boundaryTool() {
  const received = vi.fn<(params: unknown) => void>();
  const definition = tool({
    name: 'boundary_probe',
    label: 'Boundary probe',
    description: 'Exercises the shared argument boundary.',
    parameters: z.object({
      id: z.string().min(1),
      mode: z.enum(['list', 'query']),
      data: z.record(z.string(), z.unknown()),
      table: z.string().min(1).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      order: z
        .object({
          field: z.string().min(1),
          direction: z.enum(['asc', 'desc']).optional(),
        })
        .optional(),
      tags: z.array(z.string()).optional(),
      flag: z.boolean().optional(),
    }),
    execute: async (_id, params) => {
      received(params);
      return text('ok');
    },
  });
  return { definition, received };
}

/** The provider path: prepare, validate against the declared schema, run. */
async function call(definition: AgentTool, args: Record<string, unknown>) {
  const prepared = definition.prepareArguments!(args) as Record<
    string,
    unknown
  >;
  const validated = validateToolArguments(definition, {
    type: 'toolCall',
    id: 'call',
    name: definition.name,
    arguments: prepared as JsonObject,
  });
  return definition.execute('call', validated);
}

const baseline = { id: 'sample', mode: 'query', data: { a: 1 } };

describe('optional tool empty values', () => {
  it.each(EMPTY_SPELLINGS)(
    'makes populated %j optional fields equivalent to omission',
    async (empty) => {
      const { definition, received } = boundaryTool();
      await call(definition, baseline);
      const omitted = received.mock.lastCall?.[0];
      const filled = {
        ...baseline,
        table: empty,
        cursor: empty,
        limit: empty,
        order: empty,
        tags: empty,
        flag: empty,
      };
      const original = structuredClone(filled);

      await call(definition, filled);

      expect(received.mock.lastCall?.[0]).toEqual(omitted);
      expect(filled).toEqual(original);
    },
  );

  it('preserves valid enum values and nonempty string zero', async () => {
    const { definition, received } = boundaryTool();
    await call(definition, {
      ...baseline,
      cursor: '0',
      order: { field: 'title', direction: 'desc' },
    });

    expect(received.mock.lastCall?.[0]).toMatchObject({
      cursor: '0',
      order: { field: 'title', direction: 'desc' },
    });
  });

  it('keeps required empty data and explicit false, and rejects nonempty wrong types', async () => {
    const { definition, received } = boundaryTool();
    await call(definition, { ...baseline, data: {}, flag: false });
    expect(received.mock.lastCall?.[0]).toMatchObject({
      data: {},
      flag: false,
    });

    received.mockClear();
    for (const [args, error] of [
      [{ ...baseline, limit: '0' }, /argument limit: expected integer/],
      [{ ...baseline, limit: false }, /argument limit: expected integer/],
      [{ ...baseline, mode: 'other' }, /Validation failed/],
      [
        { ...baseline, order: { field: 'title', direction: 'sideways' } },
        /argument order\.direction/,
      ],
      [{ ...baseline, tags: 'a' }, /argument tags: expected array/],
    ] as const) {
      await expect(call(definition, args)).rejects.toThrow(error);
    }
    expect(received).not.toHaveBeenCalled();
  });

  it.each(EMPTY_SPELLINGS)(
    'rejects %j in a required field just like omission',
    async (empty) => {
      const { definition, received } = boundaryTool();
      const { mode: _omitted, ...withoutMode } = baseline;
      await expect(call(definition, withoutMode)).rejects.toThrow(
        /Validation failed/,
      );
      await expect(
        call(definition, { ...baseline, mode: empty }),
      ).rejects.toThrow(/Validation failed|Invalid tool argument mode/);
      expect(received).not.toHaveBeenCalled();
    },
  );

  /** Required data and optional controls of the kinds pi-ai coerces. */
  function coercionProbe() {
    return tool({
      name: 'coercion_probe',
      label: 'Coercion probe',
      description: 'Exercises provider coercion at the shared boundary.',
      parameters: z.object({
        name: z.string().min(1),
        version: z.number().int().positive(),
        clone: z.boolean(),
      }),
      execute: async () => text('ok'),
    });
  }
  // The agent loop: the tool's argument boundary, then pi's validation.
  const prepareAndValidate = (name: string, args: Record<string, unknown>) => {
    const definition = [
      coercionProbe(),
      ...createWebTools({ fetchImpl: vi.fn<typeof fetch>() }),
    ].find((candidate) => candidate.name === name)!;
    return validateToolArguments(definition, {
      type: 'toolCall',
      id: name,
      name,
      arguments: definition.prepareArguments!(args) as JsonObject,
    });
  };

  it.each([
    // Required data: null would become the string "null" or the number 0.
    ['coercion_probe', { name: null, version: 1, clone: true }],
    ['coercion_probe', { name: 'Todo', version: null, clone: true }],
    // Non-numeric strings would become 0 or 1.
    ['coercion_probe', { name: 'Todo', version: '', clone: true }],
    ['coercion_probe', { name: 'Todo', version: '   ', clone: true }],
    ['coercion_probe', { name: 'Todo', version: 'true', clone: true }],
    // Only "true"/"false" are boolean spellings.
    ['coercion_probe', { name: 'Todo', version: 1, clone: '0' }],
    // A blank optional string would become the numeric empty placeholder.
    ['web_fetch', { url: 'https://example.com', query: '   ' }],
    // Array items are data: null would become the string "null".
    ['web_search', { query: 'battery', include_domains: [null] }],
  ])(
    'rejects %s arguments pi-ai would coerce into different valid data: %j',
    (name, args) => {
      expect(() => prepareAndValidate(name, args)).toThrow(
        /Invalid tool argument/,
      );
    },
  );

  it('keeps the coercions a model means', () => {
    expect(
      prepareAndValidate('coercion_probe', {
        name: 'Todo',
        version: '5',
        clone: false,
      }),
    ).toEqual({ name: 'Todo', version: 5, clone: false });
    expect(
      prepareAndValidate('coercion_probe', {
        name: 'Todo',
        version: 1,
        clone: 'true',
      }),
    ).toEqual({ name: 'Todo', version: 1, clone: true });
    expect(
      prepareAndValidate('coercion_probe', {
        name: 7,
        version: 1,
        clone: false,
      }),
    ).toEqual({ name: '7', version: 1, clone: false });
  });
});
