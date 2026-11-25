/** Shared helpers for the Agent tool modules. */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import {
  normalizeEmptyOptionalFields,
  withEmptyOptionalFields,
  type JsonSchema,
  type PreserveEmptyValue,
} from './empty-arguments';

export type StreamDetailsSelector = (details: unknown) => unknown;
export type StreamStartDetailsSelector = (
  args: Record<string, unknown>,
) => unknown;

/** Local tool metadata consumed by the live Agent event bridge. */
export type AgentToolWithStreamDetails = AgentTool & {
  /** Select safe structured details for the live tool-start event. */
  selectStreamStartDetails?: StreamStartDetailsSelector;
  /** Select and validate structured details that the frontend needs live. */
  selectStreamDetails?: StreamDetailsSelector;
};

/**
 * The JSON Schema a zod parameter schema declares to the model. Input mode
 * keeps objects open (no `additionalProperties: false`), as pi's validation
 * has always accepted and passed through undeclared fields.
 */
export function toolJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: 'input',
  }) as JsonSchema;
  return json;
}

/**
 * Define a tool from a zod parameter schema while keeping `execute` params
 * typed from it. The schema only declares the arguments: validation and
 * coercion run on its JSON Schema, in pi and in the empty-value boundary.
 */
export function tool<S extends z.ZodObject>(def: {
  name: string;
  label: string;
  description: string;
  parameters: S;
  prepareArguments?: AgentTool['prepareArguments'];
  preserveEmptyValue?: PreserveEmptyValue;
  executionMode?: AgentTool['executionMode'];
  selectStreamStartDetails?: StreamStartDetailsSelector;
  selectStreamDetails?: StreamDetailsSelector;
  execute: (
    id: string,
    params: z.output<S>,
    signal?: AbortSignal,
    /** Stream partial output while the tool is still running. */
    onUpdate?: (partial: unknown) => void,
  ) => Promise<AgentToolResult<unknown>>;
}): AgentToolWithStreamDetails {
  const { preserveEmptyValue, ...definition } = def;
  const jsonSchema = toolJsonSchema(def.parameters);
  const parameters = withEmptyOptionalFields(jsonSchema);
  const prepareArguments = (args: unknown): z.output<S> => {
    const input = args;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Tool arguments must be an object.');
    }
    const normalized = normalizeEmptyOptionalFields(
      input as Record<string, unknown>,
      jsonSchema,
      preserveEmptyValue,
    );
    return (
      def.prepareArguments ? def.prepareArguments(normalized) : normalized
    ) as z.output<S>;
  };
  const execute: typeof def.execute = async (id, args, signal, onUpdate) =>
    def.execute(id, prepareArguments(args), signal, onUpdate);
  return {
    ...definition,
    parameters,
    prepareArguments,
    execute,
  } as unknown as AgentToolWithStreamDetails;
}

export function text(content: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

export function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error('This tool requires an Agent session id.');
  }
  return sessionId;
}

export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Cap on file page content and per-stream command output characters. */
export const MAX_FILE_CHARS = 60000;
