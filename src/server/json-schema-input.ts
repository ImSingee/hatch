/**
 * Server-only: validate App task run input against the JSON Schema captured
 * at deploy time.
 *
 * The gate is built by turning the stored JSON Schema back into a zod schema
 * ("zod from json schema") and parsing the input with it. The platform is the
 * only validator before the Connect request, whose JSON decoder rejects
 * unknown fields, so patterns are enforced and undeclared keys of a closed
 * object are rejected with the field named.
 */
import vm from 'node:vm';
import { z } from 'zod';

/**
 * Patterns are App-authored and run against request-supplied strings, so a
 * backtracking-prone pattern must not stall the platform process. Matching
 * runs in a vm context, whose timeout interrupts a runaway match, and all
 * matches of one validation share a single time budget: an input with many
 * values cannot multiply it.
 */
const PATTERN_BUDGET_MS = 200;
const patternContext = vm.createContext({ pattern: /^/, value: '' });
const patternTest = new vm.Script('pattern.test(value)');

/** Time left for pattern matching in one validation. */
type PatternBudget = { remainingMs: number };

function matchPattern(
  pattern: RegExp,
  value: string,
  budget: PatternBudget,
): boolean | 'timeout' {
  if (budget.remainingMs <= 0) return 'timeout';
  patternContext.pattern = pattern;
  patternContext.value = value;
  const started = performance.now();
  try {
    return patternTest.runInContext(patternContext, {
      timeout: Math.max(1, Math.ceil(budget.remainingMs)),
    }) as boolean;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      budget.remainingMs = 0;
      return 'timeout';
    }
    throw error;
  } finally {
    budget.remainingMs -= performance.now() - started;
    patternContext.value = '';
  }
}

/** RFC 3339, as protobuf JSON requires for `google.protobuf.Timestamp`. */
const dateTime = z.iso.datetime({ offset: true });

type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function typeOf(schema: JsonSchema): string | string[] | undefined {
  return schema.type as string | string[] | undefined;
}

export type SchemaInputOptions = {
  /** Shared pattern time budget; one per validation (set internally). */
  patternBudget?: PatternBudget;
};

/** Build a zod schema from a JSON Schema node. */
export function jsonSchemaToZod(
  input: unknown,
  options: SchemaInputOptions = {},
): z.ZodTypeAny {
  const schema = asSchema(input);
  if (!schema) return z.any();

  // Unions first — zod emits these for `.or()`, nullable, and enums of objects.
  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(union) && union.length > 0) {
    const members = union.map((u) => jsonSchemaToZod(u, options));
    return members.length === 1
      ? members[0]
      : z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if ('const' in schema) {
    return z.literal(schema.const as z.core.util.Literal);
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    return z.custom((v) => values.some((e) => Object.is(e, v) || e === v), {
      message: 'Invalid enum value',
    });
  }

  const type = typeOf(schema);
  if (Array.isArray(type)) {
    // e.g. ["string", "null"] -> string | null
    const members = type.map((t) =>
      jsonSchemaToZod({ ...schema, type: t }, options),
    );
    return members.length === 1
      ? members[0]
      : z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      const pattern =
        typeof schema.pattern === 'string' ? schema.pattern : undefined;
      const regex = pattern === undefined ? null : new RegExp(pattern);
      const format = schema.format === 'date-time';
      if (!regex && !format) return s;
      return s.superRefine((value, ctx) => {
        if (format && !dateTime.safeParse(value).success) {
          ctx.addIssue({
            code: 'custom',
            message: 'Must be an RFC 3339 date-time',
          });
        }
        if (!regex) return;
        const matched = matchPattern(
          regex,
          value,
          options.patternBudget ?? { remainingMs: PATTERN_BUDGET_MS },
        );
        if (matched === 'timeout') {
          ctx.addIssue({
            code: 'custom',
            message: `Checking the pattern ${pattern} took too long`,
          });
        } else if (!matched) {
          ctx.addIssue({
            code: 'custom',
            message: `Must match the pattern ${pattern}`,
          });
        }
      });
    }
    case 'integer':
    case 'number': {
      let n = z.number();
      if (type === 'integer') n = n.int();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = asSchema(schema.items);
      return z.array(items ? jsonSchemaToZod(items, options) : z.any());
    }
    case 'object':
      return objectToZod(schema, options);
    default:
      // No declared type but has object-ish keys -> treat as object.
      if (schema.properties) return objectToZod(schema, options);
      return z.any();
  }
}

function objectToZod(
  schema: JsonSchema,
  options: SchemaInputOptions,
): z.ZodTypeAny {
  const props = asSchema(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props)) {
    const child = asSchema(raw) ?? {};
    let field = jsonSchemaToZod(child, options);
    if ('default' in child) {
      field = field.default(child.default as never);
    } else if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  const obj = z.object(shape);
  return schema.additionalProperties === false ? obj.strict() : obj.loose();
}

/** Collect the candidate JSON Schema types for a node, peering into unions. */
function collectTypes(schema: JsonSchema): Set<string> {
  const types = new Set<string>();
  const t = typeOf(schema);
  if (typeof t === 'string') types.add(t);
  else if (Array.isArray(t)) for (const x of t) types.add(x);
  const union = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(union)) {
    for (const u of union) {
      const child = asSchema(u);
      if (child) for (const x of collectTypes(child)) types.add(x);
    }
  }
  return types;
}

/** Coerce a single query-string value toward the type the schema expects. */
function coerceScalar(schema: JsonSchema, value: string): unknown {
  // Enums carry their own (possibly numeric/boolean) member types.
  if (Array.isArray(schema.enum)) {
    const members = schema.enum as unknown[];
    if (members.length > 0 && members.every((m) => typeof m === 'number')) {
      const n = Number(value);
      if (value.trim() !== '' && !Number.isNaN(n)) return n;
    }
    if (members.length > 0 && members.every((m) => typeof m === 'boolean')) {
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    return value;
  }
  const types = collectTypes(schema);
  if (types.has('number') || types.has('integer')) {
    const n = Number(value);
    if (value.trim() !== '' && !Number.isNaN(n)) return n;
  }
  if (types.has('boolean')) {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return value;
}

/**
 * Coerce a flat query-string record toward an input schema so GET webhooks
 * (whose params are always strings) can satisfy numeric/boolean fields.
 * Unknown fields and unrepresentable types pass through untouched for the
 * validator to judge.
 */
export function coerceSchemaQueryInput(
  jsonSchema: unknown,
  raw: Record<string, string>,
): Record<string, unknown> {
  const schema = asSchema(jsonSchema);
  const props = schema ? asSchema(schema.properties) : null;
  if (!props) return { ...raw };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const child = asSchema(props[key]);
    out[key] = child ? coerceScalar(child, value) : value;
  }
  return out;
}

export type SchemaValidationResult =
  | { success: true; data: unknown }
  | { success: false; message: string };

/** Validate raw trigger input against a stored JSON Schema. */
export function validateSchemaInput(
  jsonSchema: unknown,
  rawInput: unknown,
): SchemaValidationResult {
  if (!asSchema(jsonSchema)) {
    // No schema captured — accept.
    return { success: true, data: rawInput ?? {} };
  }
  // Strict inputs arrive from callers (webhooks, the RPC): refuse one with
  // more values than any form needs before zod walks it, so validation work
  // and the issues it collects stay bounded.
  if (options.strict && exceedsValueCount(rawInput, MAX_INPUT_VALUES)) {
    return {
      success: false,
      message: `Input has more than ${MAX_INPUT_VALUES} values.`,
    };
  }
  const zodSchema = jsonSchemaToZod(jsonSchema, {
    patternBudget: { remainingMs: PATTERN_BUDGET_MS },
  });
  const parsed = zodSchema.safeParse(rawInput ?? {});
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const issues = parsed.error.issues;
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((i) => {
    const path = i.path.join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  if (issues.length > shown.length) {
    shown.push(`and ${issues.length - shown.length} more issue(s)`);
  }
  const message = shown.join('; ').slice(0, MAX_ISSUE_MESSAGE);
  return { success: false, message: message || 'Invalid input' };
}

/** Values (array items and object members, nested) a strict input may hold. */
const MAX_INPUT_VALUES = 10_000;
/** Issues spelled out in a failure message, and its length. */
const MAX_REPORTED_ISSUES = 20;
const MAX_ISSUE_MESSAGE = 4000;

/** Whether `value` holds more than `limit` values, counted iteratively. */
function exceedsValueCount(value: unknown, limit: number): boolean {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    const children = Array.isArray(next) ? next : Object.values(next);
    count += children.length;
    if (count > limit) return true;
    for (const child of children) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}
