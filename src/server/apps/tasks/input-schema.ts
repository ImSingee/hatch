/**
 * Server-only: derive a task's input JSON Schema from its RPC request message.
 *
 * The schema follows the protobuf JSON mapping the Connect request uses:
 * JSON field names, enum value names, 64-bit integers as decimal strings and
 * Timestamp/Duration as strings. Field comments become descriptions, and the
 * platform's `(hatch.app.v1.field)` options add titles, defaults and
 * constraints. Shapes a form cannot represent faithfully are rejected at
 * deploy time with the offending field named.
 */
import {
  ScalarType,
  createFileRegistry,
  getOption,
  hasOption,
  type DescEnum,
  type DescExtension,
  type DescField,
  type DescFile,
  type DescMessage,
  type FileRegistry,
} from '@bufbuild/protobuf';
import type { FileDescriptorSet } from '@bufbuild/protobuf/wkt';
import { APP_TASK_OPTIONS_PROTO_NAME } from '~agent/app-codegen';
import { validateSchemaInput } from '../../json-schema-input';
import type { TaskInputSchema } from '../manifest';

/** Raised for a request message a task cannot use as its input. */
export class TaskInputSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInputSchemaError';
  }
}

type JsonSchema = { [key: string]: unknown };

type FieldOptions = {
  title: string;
  placeholder: string;
  default: string;
  required: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern: string;
  multiline: boolean;
};

type Options = {
  field: DescExtension | undefined;
  enumValue: DescExtension | undefined;
};

/** Signed 64-bit and unsigned 64-bit integers travel as decimal strings. */
const INT64_PATTERN = '^-?[0-9]+$';
const UINT64_PATTERN = '^[0-9]+$';
const DURATION_PATTERN = '^-?[0-9]+(\\.[0-9]{1,9})?s$';

/** The platform's option extensions, when the App's proto imports them. */
function platformOptions(registry: FileRegistry): Options {
  const lookup = (name: string): DescExtension | undefined => {
    const ext = registry.getExtension(name);
    // Only the file the platform materializes defines these; anything else
    // with the same name is not trusted to carry the expected shape.
    return ext && ext.file.proto.name === APP_TASK_OPTIONS_PROTO_NAME
      ? ext
      : undefined;
  };
  return {
    field: lookup('hatch.app.v1.field'),
    enumValue: lookup('hatch.app.v1.enum_value'),
  };
}

/** Source-code-info path of a message inside its file. */
function messagePath(message: DescMessage): number[] {
  if (message.parent) {
    return [
      ...messagePath(message.parent),
      3,
      message.parent.proto.nestedType.indexOf(message.proto),
    ];
  }
  return [4, message.file.proto.messageType.indexOf(message.proto)];
}

function commentFor(file: DescFile, path: number[]): string | undefined {
  const key = path.join(',');
  const location = file.proto.sourceCodeInfo?.location.find(
    (entry) => entry.path.join(',') === key,
  );
  const text = (location?.leadingComments || location?.trailingComments || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return text || undefined;
}

function fieldComment(field: DescField): string | undefined {
  const message = field.parent;
  return commentFor(message.file, [
    ...messagePath(message),
    2,
    message.proto.field.indexOf(field.proto),
  ]);
}

function fieldOptions(
  field: DescField,
  options: Options,
): FieldOptions | undefined {
  if (!options.field || !hasOption(field, options.field)) return undefined;
  return getOption(field, options.field) as unknown as FieldOptions;
}

function enumSchema(desc: DescEnum, options: Options): JsonSchema {
  const titles = desc.values.map((value) => {
    if (options.enumValue && hasOption(value, options.enumValue)) {
      const title = (
        getOption(value, options.enumValue) as unknown as { title: string }
      ).title;
      if (title) return title;
    }
    return value.name;
  });
  return {
    type: 'string',
    enum: desc.values.map((value) => value.name),
    'x-hatch-enum-titles': titles,
  };
}

function scalarSchema(scalar: ScalarType): JsonSchema {
  switch (scalar) {
    case ScalarType.STRING:
      return { type: 'string' };
    case ScalarType.BOOL:
      return { type: 'boolean' };
    case ScalarType.BYTES:
      return { type: 'string', contentEncoding: 'base64' };
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      return { type: 'number' };
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      return {
        type: 'integer',
        minimum: -2_147_483_648,
        maximum: 2_147_483_647,
      };
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return { type: 'integer', minimum: 0, maximum: 4_294_967_295 };
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return { type: 'string', pattern: INT64_PATTERN, format: 'int64' };
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return { type: 'string', pattern: UINT64_PATTERN, format: 'uint64' };
  }
}

/**
 * Bounds on the expanded input: a message reused by several fields is
 * expanded once per use, so a small proto could otherwise describe an
 * exponentially large schema (and form) and exhaust platform memory.
 */
const MAX_TASK_INPUT_FIELDS = 1000;
const MAX_TASK_INPUT_DEPTH = 16;

type Walk = {
  options: Options;
  /** Messages on the current path, to reject recursive types. */
  stack: string[];
  /** Fields expanded so far, shared by the whole walk. */
  budget: { fields: number };
  /** Dotted JSON path of the field being converted, for errors. */
  path: string;
};

function messageSchema(message: DescMessage, walk: Walk): JsonSchema {
  if (message.typeName === 'google.protobuf.Timestamp') {
    return { type: 'string', format: 'date-time' };
  }
  if (message.typeName === 'google.protobuf.Duration') {
    return { type: 'string', pattern: DURATION_PATTERN, format: 'duration' };
  }
  if (message.typeName.startsWith('google.protobuf.')) {
    throw new TaskInputSchemaError(
      `${walk.path || 'input'} uses ${message.typeName}, which task inputs do not support. Use plain fields, a nested message, Timestamp or Duration.`,
    );
  }
  if (walk.stack.includes(message.typeName)) {
    throw new TaskInputSchemaError(
      `${walk.path || 'input'} refers back to ${message.typeName}; task inputs cannot be recursive.`,
    );
  }
  if (walk.stack.length >= MAX_TASK_INPUT_DEPTH) {
    throw new TaskInputSchemaError(
      `${walk.path || 'input'} nests messages more than ${MAX_TASK_INPUT_DEPTH} levels deep; flatten the task input.`,
    );
  }
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of message.fields) {
    const path = walk.path ? `${walk.path}.${field.jsonName}` : field.jsonName;
    walk.budget.fields += 1;
    if (walk.budget.fields > MAX_TASK_INPUT_FIELDS) {
      throw new TaskInputSchemaError(
        `the task input expands to more than ${MAX_TASK_INPUT_FIELDS} fields (at ${path}); simplify the request message.`,
      );
    }
    if (field.oneof && !field.proto.proto3Optional) {
      throw new TaskInputSchemaError(
        `${path} belongs to oneof "${field.oneof.name}", which task inputs do not support.`,
      );
    }
    const child: Walk = {
      ...walk,
      stack: [...walk.stack, message.typeName],
      path,
    };
    const schema = fieldSchema(field, child);
    properties[field.jsonName] = schema;
    if (fieldOptions(field, walk.options)?.required) {
      required.push(field.jsonName);
    }
  }
  return {
    type: 'object',
    properties,
    // Stored schemas are JSONB, which does not keep key order; forms show
    // fields in declaration order.
    'x-hatch-order': message.fields.map((field) => field.jsonName),
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function valueSchema(field: DescField, walk: Walk): JsonSchema {
  switch (field.fieldKind) {
    case 'scalar':
      return scalarSchema(field.scalar);
    case 'enum':
      return enumSchema(field.enum, walk.options);
    case 'message':
      return messageSchema(field.message, walk);
    case 'list': {
      const items =
        field.listKind === 'scalar'
          ? scalarSchema(field.scalar)
          : field.listKind === 'enum'
            ? enumSchema(field.enum, walk.options)
            : messageSchema(field.message, walk);
      return { type: 'array', items };
    }
    case 'map':
      throw new TaskInputSchemaError(
        `${walk.path} is a map, which task inputs do not support. Use a repeated message instead.`,
      );
  }
}

function applyOptions(
  schema: JsonSchema,
  field: DescField,
  options: FieldOptions | undefined,
  path: string,
): JsonSchema {
  const description = fieldComment(field);
  const out: JsonSchema = { ...schema };
  if (description) out.description = description;
  if (!options) return out;
  const isString = schema.type === 'string' && !('enum' in schema);
  const isNumber = schema.type === 'number' || schema.type === 'integer';
  if (options.title) out.title = options.title;
  if (options.placeholder) out['x-hatch-placeholder'] = options.placeholder;
  if (options.multiline) {
    if (!isString) {
      throw new TaskInputSchemaError(
        `${path}: the multiline option applies only to string fields.`,
      );
    }
    out['x-hatch-multiline'] = true;
  }
  if (options.min !== undefined || options.max !== undefined) {
    if (!isNumber) {
      throw new TaskInputSchemaError(
        `${path}: min and max apply only to numeric fields.`,
      );
    }
    // Intersect with the protobuf type's own range (e.g. uint32 >= 0): an
    // option may narrow it, never widen it.
    if (options.min !== undefined) {
      out.minimum =
        typeof schema.minimum === 'number'
          ? Math.max(schema.minimum, options.min)
          : options.min;
    }
    if (options.max !== undefined) {
      out.maximum =
        typeof schema.maximum === 'number'
          ? Math.min(schema.maximum, options.max)
          : options.max;
    }
  }
  if (
    options.minLength !== undefined ||
    options.maxLength !== undefined ||
    options.pattern
  ) {
    if (!isString) {
      throw new TaskInputSchemaError(
        `${path}: min_length, max_length and pattern apply only to string fields.`,
      );
    }
    if (options.minLength !== undefined) out.minLength = options.minLength;
    if (options.maxLength !== undefined) out.maxLength = options.maxLength;
    if (options.pattern) {
      try {
        new RegExp(options.pattern);
      } catch {
        throw new TaskInputSchemaError(
          `${path}: pattern ${JSON.stringify(options.pattern)} is not a valid regular expression.`,
        );
      }
      // A declared pattern replaces the 64-bit digits check: it is stricter.
      out.pattern = options.pattern;
    }
  }
  if (options.default) {
    let value: unknown;
    try {
      value = JSON.parse(options.default);
    } catch {
      throw new TaskInputSchemaError(
        `${path}: default ${JSON.stringify(options.default)} is not valid JSON. Quote string defaults, for example "\\"main\\"".`,
      );
    }
    const check = validateSchemaInput(
      { type: 'object', properties: { value: out }, required: ['value'] },
      { value },
      { strict: true },
    );
    if (!check.success) {
      throw new TaskInputSchemaError(
        `${path}: default ${options.default} does not fit the field (${check.message.replace(/^value: /, '')}).`,
      );
    }
    // The parsed value: a message default gets its nested defaults filled.
    out.default = (check.data as { value: unknown }).value;
  }
  return out;
}

function fieldSchema(field: DescField, walk: Walk): JsonSchema {
  return applyOptions(
    valueSchema(field, walk),
    field,
    fieldOptions(field, walk.options),
    walk.path,
  );
}

/** Registry over an App's compiled descriptor set. */
export function taskDescriptorRegistry(set: FileDescriptorSet): FileRegistry {
  return createFileRegistry(set);
}

/** The JSON Schema of one request message, or a TaskInputSchemaError. */
export function taskInputSchema(
  registry: FileRegistry,
  inputType: string,
): TaskInputSchema {
  const message = registry.getMessage(inputType);
  if (!message) {
    throw new TaskInputSchemaError(
      `request message ${inputType} is not in the compiled proto.`,
    );
  }
  // The run input is a JSON object everywhere (form, RPC, CLI, webhook), so
  // the request must be an App message; well-known types stay usable as
  // fields.
  if (message.typeName.startsWith('google.protobuf.')) {
    throw new TaskInputSchemaError(
      `the request type ${message.typeName} is not a message of the App; wrap it in a request message with a field of that type.`,
    );
  }
  // Built only from strings, numbers, booleans, arrays and plain objects.
  return messageSchema(message, {
    options: platformOptions(registry),
    stack: [],
    budget: { fields: 0 },
    path: '',
  }) as TaskInputSchema;
}
