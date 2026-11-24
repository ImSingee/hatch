import {
  Alert,
  Button,
  Group,
  JsonInput,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import { useState } from 'react';

/**
 * A run form inferred from a JSON Schema: one input per property of a flat
 * object schema, or a raw JSON editor for anything else. Shared by Workflow
 * runs and App task runs; the caller starts the run.
 */
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  /** Placeholder text (task input option). */
  'x-hatch-placeholder'?: string;
  /** Render a string as a text area (task input option). */
  'x-hatch-multiline'?: boolean;
  /** Labels for `enum` members, in the same order (task input option). */
  'x-hatch-enum-titles'?: string[];
  /** Property order of an object schema (stored schemas lose key order). */
  'x-hatch-order'?: string[];
};

/**
 * Unwrap a zod-emitted union (`anyOf`/`oneOf`, used for `.nullable()` and
 * simple unions) to the concrete member that drives the input: drop the `null`
 * branch and take the first remaining member, keeping any metadata the parent
 * node carries. Without this, a required nullable field has no top-level `type`
 * and falls back to a raw JSON editor that submit() then drops. Mirrors the
 * server validator, which also understands these union nodes.
 */
function effectiveSchema(schema: JsonSchema): JsonSchema {
  const union = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(union) || union.length === 0) return schema;
  const member = union.find((m) => m && m.type !== 'null') ?? union[0] ?? {};
  const declared = 'default' in schema ? schema : member;
  return {
    ...member,
    // Only carry `default` when the parent or member declares one; an
    // explicit `default: undefined` would defeat initialValues' fallbacks.
    ...('default' in declared ? { default: declared.default } : {}),
    title: schema.title ?? member.title,
    description: schema.description ?? member.description,
    enum: schema.enum ?? member.enum,
    'x-hatch-placeholder':
      schema['x-hatch-placeholder'] ?? member['x-hatch-placeholder'],
    'x-hatch-multiline':
      schema['x-hatch-multiline'] ?? member['x-hatch-multiline'],
    'x-hatch-enum-titles':
      schema['x-hatch-enum-titles'] ?? member['x-hatch-enum-titles'],
  };
}

type Field = {
  key: string;
  schema: JsonSchema;
  required: boolean;
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'json';
};

function typeOf(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== 'null') ?? schema.type[0];
  }
  return schema.type;
}

function fieldKind(schema: JsonSchema): Field['kind'] {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  const t = typeOf(schema);
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'integer') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'json';
}

/** Build flat field descriptors from an object schema, or null if not inferable. */
function inferFields(schema: JsonSchema | null): Field[] | null {
  if (!schema || typeOf(schema) !== 'object' || !schema.properties) return null;
  const required = new Set(schema.required ?? []);
  const order = schema['x-hatch-order'] ?? [];
  const rank = (key: string) => {
    const index = order.indexOf(key);
    return index === -1 ? order.length : index;
  };
  return Object.entries(schema.properties)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, propSchema]) => {
      const eff = effectiveSchema(propSchema);
      return {
        key,
        schema: eff,
        required: required.has(key),
        kind: fieldKind(eff),
      };
    });
}

function initialValues(fields: Field[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if ('default' in f.schema) {
      values[f.key] = f.schema.default;
    } else if (f.kind === 'boolean') {
      // Leave an optional boolean unset so an untouched switch is omitted on
      // submit and the schema's own default applies; a required one still
      // starts at false (a valid value the user can flip).
      values[f.key] = f.required ? false : undefined;
    } else {
      values[f.key] = '';
    }
  }
  return values;
}

export function SchemaRunForm({
  formKey,
  inputSchema,
  disabled,
  pending,
  onSubmit,
  emptyText,
}: {
  /** Identity of the run target; the form resets when it changes. */
  formKey: string;
  inputSchema: unknown;
  disabled?: boolean;
  pending: boolean;
  onSubmit: (input: unknown) => void;
  /** Shown instead of fields when the schema declares no properties. */
  emptyText: string;
}) {
  const schema = (inputSchema ?? null) as JsonSchema | null;
  const fields = inferFields(schema);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    fields ? initialValues(fields) : {},
  );
  // Raw JSON editor used when the schema isn't a simple flat object.
  const [rawJson, setRawJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  // Fields the user has edited; an explicitly cleared string is submitted
  // as '' while untouched optional fields stay omitted.
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());

  // Reset the form when the target (or its input schema) changes without a
  // remount — e.g. navigating between two run pages, or a redeploy that
  // alters the schema. Otherwise stale values leak across targets and new
  // defaults never apply. (React's "adjust state during render" pattern.)
  const resetKey = `${formKey}|${JSON.stringify(inputSchema ?? null)}`;
  const [appliedKey, setAppliedKey] = useState(resetKey);
  if (appliedKey !== resetKey) {
    setAppliedKey(resetKey);
    setValues(fields ? initialValues(fields) : {});
    setRawJson('{}');
    setError(null);
    setEdited(new Set());
  }

  const setValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setEdited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };

  const submit = () => {
    setError(null);
    let input: unknown;
    if (fields) {
      // A required object/array is rendered as a raw JSON editor whose empty
      // value would otherwise be silently dropped, so the run fails server-side
      // for missing input. Surface that inline. Other kinds aren't checked
      // here: an empty string is a valid required value (schema only requires
      // the property to be present), so the server stays the source of truth.
      for (const f of fields) {
        if (!f.required || f.kind !== 'json') continue;
        const v = values[f.key];
        // Only the string editor value can be empty. A non-string value is a
        // schema default (object/array) the server applies when the field is
        // omitted, so don't block those.
        if (typeof v === 'string' && !v.trim()) {
          setError(`Field "${f.schema.title ?? f.key}" is required.`);
          return;
        }
      }
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.key];
        if (f.kind === 'json') {
          if (typeof v === 'string' && v.trim()) {
            try {
              obj[f.key] = JSON.parse(v);
            } catch {
              setError(`Field "${f.key}" must be valid JSON.`);
              return;
            }
          }
          continue;
        }
        // Skip untouched empty optional fields so schema defaults apply; an
        // optional string the user cleared is sent as '' on purpose.
        if ((v === '' || v === undefined) && !f.required) {
          if (!(f.kind === 'string' && v === '' && edited.has(f.key))) continue;
        }
        if (f.kind === 'enum') {
          // The Select stores the stringified option label; map it back to the
          // original enum value so non-string enums (e.g. [1, 2]) keep their
          // type and pass server-side validation.
          const original = (f.schema.enum ?? []).find((o) => String(o) === v);
          obj[f.key] = original === undefined ? v : original;
          continue;
        }
        obj[f.key] = v;
      }
      input = obj;
    } else {
      try {
        input = rawJson.trim() ? JSON.parse(rawJson) : {};
      } catch {
        setError('Input must be valid JSON.');
        return;
      }
    }
    onSubmit(input);
  };

  return (
    <Stack gap="md">
      {fields && fields.length > 0 ? (
        fields.map((f) => {
          const label = f.schema.title ?? f.key;
          const desc = f.schema.description;
          if (f.kind === 'boolean') {
            return (
              <Switch
                key={f.key}
                label={label}
                description={desc}
                checked={Boolean(values[f.key])}
                onChange={(e) => setValue(f.key, e.currentTarget.checked)}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'enum') {
            const titles = f.schema['x-hatch-enum-titles'];
            return (
              <Select
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                data={(f.schema.enum ?? []).map((o, index) => ({
                  value: String(o),
                  label: titles?.[index] ?? String(o),
                }))}
                value={values[f.key] == null ? null : String(values[f.key])}
                onChange={(v) => setValue(f.key, v ?? '')}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'number') {
            return (
              <NumberInput
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                min={f.schema.minimum}
                max={f.schema.maximum}
                placeholder={f.schema['x-hatch-placeholder']}
                value={
                  values[f.key] === '' || values[f.key] == null
                    ? ''
                    : Number(values[f.key])
                }
                onChange={(v) => setValue(f.key, v)}
                disabled={disabled}
              />
            );
          }
          if (f.kind === 'json') {
            return (
              <JsonInput
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                autosize
                minRows={2}
                formatOnBlur
                value={
                  typeof values[f.key] === 'string'
                    ? (values[f.key] as string)
                    : ''
                }
                onChange={(v) => setValue(f.key, v)}
                disabled={disabled}
              />
            );
          }
          if (f.schema['x-hatch-multiline']) {
            return (
              <Textarea
                key={f.key}
                label={label}
                description={desc}
                required={f.required}
                autosize
                minRows={3}
                placeholder={f.schema['x-hatch-placeholder']}
                value={
                  typeof values[f.key] === 'string'
                    ? (values[f.key] as string)
                    : ''
                }
                onChange={(e) => setValue(f.key, e.currentTarget.value)}
                disabled={disabled}
              />
            );
          }
          return (
            <TextInput
              key={f.key}
              label={label}
              description={desc}
              required={f.required}
              placeholder={f.schema['x-hatch-placeholder']}
              value={
                typeof values[f.key] === 'string'
                  ? (values[f.key] as string)
                  : ''
              }
              onChange={(e) => setValue(f.key, e.currentTarget.value)}
              disabled={disabled}
            />
          );
        })
      ) : fields ? (
        <Text size="sm" c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <JsonInput
          label="Input (JSON)"
          description="This input schema is custom — provide raw JSON."
          autosize
          minRows={4}
          formatOnBlur
          value={rawJson}
          onChange={setRawJson}
          disabled={disabled}
        />
      )}

      {error ? (
        <Alert color="red" variant="light" py="xs">
          {error}
        </Alert>
      ) : null}

      <Group justify="flex-end">
        <Button
          type="button"
          leftSection={<IconPlayerPlay size={16} stroke={1.8} />}
          loading={pending}
          disabled={disabled}
          onClick={submit}
        >
          Run now
        </Button>
      </Group>
    </Stack>
  );
}
