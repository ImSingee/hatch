import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_TASK_OPTIONS_PROTO,
  APP_TASK_OPTIONS_PROTO_FILE,
} from '~agent/app-codegen';
import { REPO_ROOT } from '~agent/paths';
import { validateSchemaInput } from '../../json-schema-input';
import { taskDescriptorRegistry, taskInputSchema } from './input-schema';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Compile one App proto the way the build does, with the platform options. */
function compile(body: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'task-input-'));
  roots.push(root);
  const options = path.join(root, '.hatch', APP_TASK_OPTIONS_PROTO_FILE);
  mkdirSync(path.dirname(options), { recursive: true });
  writeFileSync(options, APP_TASK_OPTIONS_PROTO);
  mkdirSync(path.join(root, 'proto'));
  writeFileSync(
    path.join(root, 'buf.yaml'),
    'version: v2\nmodules:\n  - path: proto\n  - path: .hatch/proto\n',
  );
  writeFileSync(
    path.join(root, 'proto', 'service.proto'),
    `syntax = "proto3";\npackage app.v1;\nimport "hatch/app/v1/options.proto";\nimport "google/protobuf/timestamp.proto";\nimport "google/protobuf/struct.proto";\n${body}`,
  );
  execFileSync(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'buf'),
    ['build', '-o', 'out.binpb'],
    { cwd: root, stdio: 'pipe' },
  );
  return taskDescriptorRegistry(
    fromBinary(
      FileDescriptorSetSchema,
      readFileSync(path.join(root, 'out.binpb')),
    ),
  );
}

describe('task input schema', () => {
  it('maps the protobuf JSON shape and the platform field options', () => {
    const registry = compile(`
enum Mode {
  MODE_UNSPECIFIED = 0;
  MODE_FAST = 1 [(hatch.app.v1.enum_value) = { title: "Fast" }];
}
message Item { string label = 1; }
message Req {
  // owner/name
  string repo = 1 [(hatch.app.v1.field) = { required: true, pattern: "^[^/]+/[^/]+$" }];
  int32 limit = 2 [(hatch.app.v1.field) = { default: "20", min: 1, max: 100 }];
  int64 big = 3;
  Mode mode = 4;
  repeated Item items = 5;
  google.protobuf.Timestamp since = 6;
  optional bool dry_run = 7;
  string notes = 8 [(hatch.app.v1.field) = { title: "Notes", multiline: true, placeholder: "…" }];
}`);
    const schema = taskInputSchema(registry, 'app.v1.Req');
    expect(schema).toMatchObject({
      type: 'object',
      required: ['repo'],
      additionalProperties: false,
      'x-hatch-order': [
        'repo',
        'limit',
        'big',
        'mode',
        'items',
        'since',
        'dryRun',
        'notes',
      ],
      properties: {
        repo: {
          type: 'string',
          pattern: '^[^/]+/[^/]+$',
          description: 'owner/name',
        },
        limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        big: { type: 'string', pattern: '^-?[0-9]+$' },
        mode: {
          enum: ['MODE_UNSPECIFIED', 'MODE_FAST'],
          'x-hatch-enum-titles': ['MODE_UNSPECIFIED', 'Fast'],
        },
        items: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' } } },
        },
        since: { type: 'string', format: 'date-time' },
        dryRun: { type: 'boolean' },
        notes: {
          title: 'Notes',
          'x-hatch-multiline': true,
          'x-hatch-placeholder': '…',
        },
      },
    });
    // The platform validates with these schemas before every run.
    expect(validateSchemaInput(schema, { repo: 'a/b' })).toEqual({
      success: true,
      data: { repo: 'a/b', limit: 20 },
    });
    const rejected = validateSchemaInput(schema, {
      repo: 'ab',
      limit: 101,
      other: true,
    });
    expect(rejected.success).toBe(false);
  });

  it('stores a message default with its nested defaults filled', () => {
    const registry = compile(`
message Inner { int32 limit = 1 [(hatch.app.v1.field) = { default: "20" }]; }
message Req { Inner inner = 1 [(hatch.app.v1.field) = { default: "{}" }]; }
`);
    const schema = taskInputSchema(registry, 'app.v1.Req') as {
      properties: { inner: { default: unknown } };
    };
    expect(schema.properties.inner.default).toEqual({ limit: 20 });
  });

  it.each([
    ['a map', 'message Req { map<string, string> tags = 1; }', /map/],
    [
      'a oneof',
      'message Req { oneof pick { string a = 1; string b = 2; } }',
      /oneof "pick"/,
    ],
    ['a recursive message', 'message Req { Req child = 1; }', /recursive/],
    [
      'a Struct',
      'message Req { google.protobuf.Struct data = 1; }',
      /google\.protobuf\.Struct/,
    ],
    [
      'a default of the wrong type',
      'message Req { int32 n = 1 [(hatch.app.v1.field) = { default: "\\"x\\"" }]; }',
      /default "x" does not fit/,
    ],
    [
      'a default outside the protobuf type range',
      'message Req { uint32 n = 1 [(hatch.app.v1.field) = { min: -1, default: "-1" }]; }',
      /default -1 does not fit/,
    ],
    [
      'a message graph that expands to too many fields',
      'message M0 { M1 a = 1; M1 b = 2; }\nmessage M1 { M2 a = 1; M2 b = 2; }\nmessage M2 { M3 a = 1; M3 b = 2; }\nmessage M3 { M4 a = 1; M4 b = 2; }\nmessage M4 { M5 a = 1; M5 b = 2; }\nmessage M5 { M6 a = 1; M6 b = 2; }\nmessage M6 { M7 a = 1; M7 b = 2; }\nmessage M7 { M8 a = 1; M8 b = 2; }\nmessage M8 { M9 a = 1; M9 b = 2; }\nmessage M9 { M10 a = 1; M10 b = 2; }\nmessage M10 { M11 a = 1; M11 b = 2; }\nmessage M11 { M12 a = 1; M12 b = 2; }\nmessage M12 { string leaf = 1; }\nmessage Req { M0 root = 1; }',
      /expands to more than 1000 fields/,
    ],
    [
      'bounds on a string',
      'message Req { string s = 1 [(hatch.app.v1.field) = { min: 1 }]; }',
      /min and max apply only to numeric fields/,
    ],
  ])('rejects %s', (_label, body, message) => {
    const registry = compile(body);
    expect(() => taskInputSchema(registry, 'app.v1.Req')).toThrow(message);
  });

  it('rejects a well-known type as the request but keeps it usable as a field', () => {
    const registry = compile(
      'message Req { google.protobuf.Timestamp at = 1; }',
    );
    expect(() =>
      taskInputSchema(registry, 'google.protobuf.Timestamp'),
    ).toThrow(/not a message of the App/);
    expect(taskInputSchema(registry, 'app.v1.Req')).toMatchObject({
      properties: { at: { type: 'string', format: 'date-time' } },
    });
  });
});
