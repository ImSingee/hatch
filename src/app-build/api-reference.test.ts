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
import { REPO_ROOT } from '~agent/paths';
import { describeApi } from './api-reference';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Compile one App proto with buf, the way the build does. */
function compile(body: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'api-reference-'));
  roots.push(root);
  mkdirSync(path.join(root, 'proto'));
  writeFileSync(
    path.join(root, 'buf.yaml'),
    'version: v2\nmodules:\n  - path: proto\n',
  );
  writeFileSync(
    path.join(root, 'proto', 'service.proto'),
    `syntax = "proto3";\npackage app.v1;\nimport "google/protobuf/timestamp.proto";\n${body}`,
  );
  execFileSync(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'buf'),
    ['build', '-o', 'out.binpb'],
    { cwd: root, stdio: 'pipe' },
  );
  return fromBinary(
    FileDescriptorSetSchema,
    readFileSync(path.join(root, 'out.binpb')),
  );
}

const PROTO = `
// Keeps a list of todos.
//
// Each todo belongs to one list.
service TodoService {
  // Lists the todos of one list.
  rpc ListTodos(ListTodosRequest) returns (ListTodosResponse) {
    option idempotency_level = NO_SIDE_EFFECTS;
  }
  // Replaces a todo's title.
  rpc RenameTodo(RenameTodoRequest) returns (Todo) {
    option idempotency_level = IDEMPOTENT;
  }
  rpc CreateTodo(CreateTodoRequest) returns (Todo) {
    option deprecated = true;
  }
  // Streams changes.
  rpc WatchTodos(ListTodosRequest) returns (stream Todo);
}

// buf:lint:ignore COMMENT_MESSAGE
// Filter for ListTodos.
message ListTodosRequest {
  string list_id = 1; // The list to read.
  optional int32 limit = 2;
  Status status = 3;
}

message ListTodosResponse {
  repeated Todo todos = 1;
  map<string, Todo.Tag> tags = 2;
}

message RenameTodoRequest {
  int64 id = 1;
  string title = 2 [deprecated = true];
  oneof target {
    string by_name = 3;
    int64 by_id = 4;
  }
}

message CreateTodoRequest { string title = 1; }

// A todo item.
message Todo {
  // A label on a todo.
  message Tag { string name = 1; }
  int64 id = 1;
  string title = 2;
  google.protobuf.Timestamp due = 3;
  // Todos that block this one.
  repeated Todo blocked_by = 4;
}

// Where a todo is.
enum Status {
  STATUS_UNSPECIFIED = 0;
  // Still to do.
  STATUS_OPEN = 1;
  STATUS_DONE = 2 [deprecated = true];
}

// Not used by any method.
message Unused { string x = 1; }
enum UnusedEnum { UNUSED_ENUM_UNSPECIFIED = 0; }
`;

describe('describeApi', () => {
  const api = describeApi(compile(PROTO));

  it('documents services and methods from comments and built-in options', () => {
    expect(api.services).toEqual([
      {
        name: 'app.v1.TodoService',
        description: 'Keeps a list of todos.\n\nEach todo belongs to one list.',
        methods: [
          {
            name: 'ListTodos',
            description: 'Lists the todos of one list.',
            inputType: 'app.v1.ListTodosRequest',
            outputType: 'app.v1.ListTodosResponse',
            clientStreaming: false,
            serverStreaming: false,
            idempotency: 'no_side_effects',
          },
          {
            name: 'RenameTodo',
            description: "Replaces a todo's title.",
            inputType: 'app.v1.RenameTodoRequest',
            outputType: 'app.v1.Todo',
            clientStreaming: false,
            serverStreaming: false,
            idempotency: 'idempotent',
          },
          {
            name: 'CreateTodo',
            inputType: 'app.v1.CreateTodoRequest',
            outputType: 'app.v1.Todo',
            clientStreaming: false,
            serverStreaming: false,
            deprecated: true,
          },
          {
            name: 'WatchTodos',
            description: 'Streams changes.',
            inputType: 'app.v1.ListTodosRequest',
            outputType: 'app.v1.Todo',
            clientStreaming: false,
            serverStreaming: true,
          },
        ],
      },
    ]);
  });

  it('describes every field shape with its JSON name', () => {
    const message = (name: string) =>
      api.types.messages.find((entry) => entry.name === name);
    expect(message('app.v1.ListTodosRequest')).toEqual({
      name: 'app.v1.ListTodosRequest',
      description: 'Filter for ListTodos.',
      fields: [
        {
          name: 'list_id',
          jsonName: 'listId',
          kind: 'scalar',
          type: 'string',
          label: 'single',
          description: 'The list to read.',
        },
        {
          name: 'limit',
          jsonName: 'limit',
          kind: 'scalar',
          type: 'int32',
          label: 'optional',
        },
        {
          name: 'status',
          jsonName: 'status',
          kind: 'enum',
          type: 'app.v1.Status',
          label: 'single',
        },
      ],
    });
    expect(message('app.v1.ListTodosResponse')?.fields).toEqual([
      {
        name: 'todos',
        jsonName: 'todos',
        kind: 'message',
        type: 'app.v1.Todo',
        label: 'repeated',
      },
      {
        name: 'tags',
        jsonName: 'tags',
        kind: 'message',
        type: 'app.v1.Todo.Tag',
        label: 'map',
        mapKey: 'string',
      },
    ]);
    expect(message('app.v1.RenameTodoRequest')?.fields).toEqual([
      expect.objectContaining({ name: 'id', type: 'int64' }),
      expect.objectContaining({ name: 'title', deprecated: true }),
      expect.objectContaining({ name: 'by_name', oneof: 'target' }),
      expect.objectContaining({ name: 'by_id', oneof: 'target' }),
    ]);
    expect(message('app.v1.Todo')?.fields).toContainEqual({
      name: 'due',
      jsonName: 'due',
      kind: 'message',
      type: 'google.protobuf.Timestamp',
      label: 'single',
    });
    expect(message('app.v1.Todo.Tag')).toEqual({
      name: 'app.v1.Todo.Tag',
      description: 'A label on a todo.',
      fields: [expect.objectContaining({ name: 'name' })],
    });
  });

  it('includes reachable App types once, without well-known or unused types', () => {
    expect(api.types.messages.map((entry) => entry.name).sort()).toEqual([
      'app.v1.CreateTodoRequest',
      'app.v1.ListTodosRequest',
      'app.v1.ListTodosResponse',
      'app.v1.RenameTodoRequest',
      'app.v1.Todo',
      'app.v1.Todo.Tag',
    ]);
    expect(api.types.enums).toEqual([
      {
        name: 'app.v1.Status',
        description: 'Where a todo is.',
        values: [
          { name: 'STATUS_UNSPECIFIED', number: 0 },
          { name: 'STATUS_OPEN', number: 1, description: 'Still to do.' },
          { name: 'STATUS_DONE', number: 2, deprecated: true },
        ],
      },
    ]);
  });
});
