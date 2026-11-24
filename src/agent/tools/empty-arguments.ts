/** A JSON Schema object (as produced by `z.toJSONSchema`). */
export type JsonSchema = Record<string, unknown>;

type ObjectSchema = JsonSchema & {
  description?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

/** Empty spellings a model may send for an omitted optional field. */
const EMPTY_PLACEHOLDERS: JsonSchema[] = [
  { type: 'string', const: '' },
  { type: 'null' },
  { type: 'number', const: 0 },
  { type: 'array', items: {}, maxItems: 0 },
  { type: 'object', properties: {}, additionalProperties: false },
];

export type PreserveEmptyValue = (
  fieldPath: string,
  input: Record<string, unknown>,
) => boolean;

function isEmptyOptionalValue(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function hasDeclaredTypeAndEnumValue(
  value: unknown,
  shape: ObjectSchema,
): boolean {
  if (Object.hasOwn(shape, 'const') && value !== shape.const) return false;
  if (shape.enum && !shape.enum.includes(value)) return false;
  if (shape.anyOf) {
    return shape.anyOf.some((member) =>
      hasDeclaredTypeAndEnumValue(value, member as ObjectSchema),
    );
  }
  const type =
    shape.type ??
    (Object.hasOwn(shape, 'const') ? typeof shape.const : undefined);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number';
  return typeof type !== 'string' || typeof value === type;
}

function isNumericString(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * Why pi-ai must not see `value`, or undefined. pi-ai coerces arguments before
 * it validates them, and some coercions turn an invalid value into a valid but
 * different one: `null` into the string "null", "" or "true" into a number, a
 * blank string into the numeric `0` empty placeholder of an optional field.
 * Only the conversions a model plausibly means are left to pi-ai: numbers and
 * booleans for strings, numeric strings for numbers, "true"/"false" for
 * booleans.
 */
function coercionHazard(
  value: unknown,
  shape: ObjectSchema,
  optional: boolean,
): string | undefined {
  const type = shape.type;
  if (typeof type !== 'string') return undefined;
  if (value === null) {
    return !optional &&
      (type === 'string' || type === 'number' || type === 'integer')
      ? `expected ${type}, got null`
      : undefined;
  }
  if (typeof value !== 'string') return undefined;
  if ((type === 'number' || type === 'integer') && !isNumericString(value)) {
    return `expected ${type}, got a non-numeric string`;
  }
  if (type === 'boolean' && value !== 'true' && value !== 'false') {
    return 'expected boolean';
  }
  if (type !== 'string' || !optional) return undefined;
  // An optional string that breaks its own constraints would otherwise be
  // coerced into an empty placeholder and silently omitted.
  const length = [...value].length;
  if (shape.minLength !== undefined && length < shape.minLength) {
    return `expected at least ${shape.minLength} characters`;
  }
  if (shape.maxLength !== undefined && length > shape.maxLength) {
    return `expected at most ${shape.maxLength} characters`;
  }
  if (shape.pattern !== undefined && !new RegExp(shape.pattern).test(value)) {
    return `expected to match ${shape.pattern}`;
  }
  return undefined;
}

/** Optional fields need a placeholder for models that always emit them. */
export function withEmptyOptionalFields(schema: JsonSchema): JsonSchema {
  const source = schema as ObjectSchema;
  const result: ObjectSchema = { ...source };
  if (source.anyOf) {
    result.anyOf = source.anyOf.map(withEmptyOptionalFields);
  }
  if (source.items) result.items = withEmptyOptionalFields(source.items);
  if (source.properties) {
    result.properties = Object.fromEntries(
      Object.entries(source.properties).map(([key, field]) => {
        const adapted = withEmptyOptionalFields(field);
        return [
          key,
          source.required?.includes(key)
            ? adapted
            : {
                anyOf: [adapted, ...structuredClone(EMPTY_PLACEHOLDERS)],
                ...(typeof (field as ObjectSchema).description === 'string'
                  ? { description: (field as ObjectSchema).description }
                  : {}),
              },
        ];
      }),
    );
  }
  return result;
}

/** Only visit declared fields, never arbitrary JSON records or user data. */
export function normalizeEmptyOptionalFields(
  input: Record<string, unknown>,
  schema: JsonSchema,
  preserve?: PreserveEmptyValue,
): Record<string, unknown> {
  function normalize(
    value: unknown,
    shape: ObjectSchema,
    path: string,
  ): unknown {
    if (Array.isArray(value) && shape.items) {
      return value.map((item, index) =>
        normalize(item, shape.items as ObjectSchema, `${path}.${index}`),
      );
    }
    if (!value || typeof value !== 'object' || !shape.properties) return value;
    const result: Record<string, unknown> = { ...value };
    for (const [key, field] of Object.entries(shape.properties)) {
      if (!Object.hasOwn(result, key)) continue;
      const fieldPath = path ? `${path}.${key}` : key;
      const optional = !shape.required?.includes(key);
      if (
        isEmptyOptionalValue(result[key]) &&
        optional &&
        !preserve?.(fieldPath, input)
      ) {
        delete result[key];
      } else {
        // Check original types and enum membership before pi-ai can turn a
        // nonempty invalid value (for example "0") into an empty spelling.
        if (
          optional &&
          result[key] !== undefined &&
          !hasDeclaredTypeAndEnumValue(result[key], field as ObjectSchema)
        ) {
          throw new Error(
            `Invalid tool argument ${fieldPath}: expected ${String((field as ObjectSchema).type ?? 'declared type or enum value')}.`,
          );
        }
        const hazard = coercionHazard(
          result[key],
          field as ObjectSchema,
          optional,
        );
        if (hazard) {
          throw new Error(`Invalid tool argument ${fieldPath}: ${hazard}.`);
        }
        result[key] = normalize(result[key], field as ObjectSchema, fieldPath);
      }
    }
    return result;
  }
  return normalize(input, schema as ObjectSchema, '') as Record<
    string,
    unknown
  >;
}
