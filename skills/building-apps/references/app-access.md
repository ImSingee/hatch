# Reaching other Apps

Read this reference when one App needs another App's backend methods, Data
Tables, tasks or webhook. The calling App's backend lists what it needs under
`appAccess` in its manifest, and calls it with `@hatch/app/apps`. The platform
checks the grant, forwards the request and tells the target which App is
calling.

Only the backend can reach other Apps. A frontend calls its own backend, which
relays. The relay refuses browser sessions, API keys and Run credentials.

## Manifest

Find the target's immutable id with `hatch app list --json` (never use the
slug: it can be renamed). List every item explicitly; a list you leave out
grants nothing.

```ts
capabilities: { backend: true },
backend: { entry: 'backend/main.ts', network: [] },
appAccess: [
  {
    app: '01jabcdefghjkmnpqrstvwxyz0', // target App id
    alias: 'todos', // optional name for code, unique in this App
    rpc: [
      'app.v1.TodoService/ListTodos', // one method
      'app.v1.ReportService/*', // every method of a service
    ],
    dataTables: {
      read: ['items'], // query only
      write: ['notes'], // insert, patch, increment, delete (and query)
    },
    tasks: ['digest'], // start runs and read the runs this App started
    webhook: ['/ingest', '/media/*'], // exact path, or a path and below
  },
],
```

- `rpc` also accepts `'*'` for every method; `webhook` accepts `'*'` for every
  path. Prefer naming the items.
- Webhook paths use plain segments: no `..`, query strings or encoded bytes.
- Each target is listed once, and never this App itself.
- The deploy fails when a target id does not exist or is archived. Whether the
  target still has each method, table, task or webhook is checked on every
  call, because the target deploys on its own. The App's manage page and
  `hatch app get <id> --json` (`ops.appAccess.outgoing`) mark items the
  target's live deployment no longer has.
- `backend.network` needs no entry for the platform: a declared `appAccess`
  adds it automatically.
- A rollback restores the grants of the deployment it returns to.

## Calling from the backend

```ts
import { connectApp, AppAccessError } from '@hatch/app/apps';

const todos = connectApp('todos'); // an alias or an App id from appAccess

// Unary Connect call with JSON in and out.
const list = await todos.call<{ todos: Todo[] }>(
  'app.v1.TodoService/ListTodos',
  { limit: 20 },
  { timeoutMs: 10_000 },
);

// Data Tables: the same client as @hatch/app/data, without realtime changes.
const items = await todos.data().query({ table: 'items', limit: 50 });
await todos.data().insert('notes', { text: 'from another App' });

// Tasks: queue a run, then read it.
const { runId } = await todos.tasks.start('digest', { repo: 'denoland/deno' });
const run = await todos.tasks.get(runId);

// Webhook: any method and body, streamed (files and video included).
const file = await Deno.open(`${Deno.env.get('STORAGE_DIR')}/clip.mp4`);
await todos.webhook('/media/clip.mp4', { method: 'PUT', body: file.readable });
```

For typed clients generated from the target's proto, pass the connection to a
Connect transport:

```ts
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';

const transport = createConnectTransport({
  baseUrl: todos.rpcBaseUrl,
  fetch: todos.fetch,
});
const client = createClient(TodoService, transport);
```

Failures throw `AppAccessError` with `code`, `message` and `status`:

| `code`              | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `permission_denied` | Not listed in `appAccess`, or a frontend credential was sent |
| `unauthenticated`   | The signature is missing or stale; redeploy the backend      |
| `not_found`         | The target is missing, archived or has no such method or run |
| `unavailable`       | The target lacks the capability (no backend, tables, tasks…) |
| `invalid_argument`  | A malformed path or body                                     |

Errors raised by the target's own code arrive unchanged: Connect errors from
its methods, Data errors as `DataRequestError`, and the webhook's own response.

Your App depends on the target's method signatures and table fields. When the
target changes them, update and redeploy this App.

## Receiving calls

A target needs no manifest change: any App that lists it may call it. To know
who is calling, check the platform's signature:

```ts
import { appCaller, verifyPlatformRequest } from '@hatch/app/apps';

// In a Connect handler: { appId } for a relayed call, null otherwise.
const caller = await appCaller({
  method: context.requestMethod,
  url: context.url,
  headers: context.requestHeader,
});

// In /__webhook: { via: 'platform' } for a platform webhook,
// { via: 'app', appId } for a relayed call, null when unsigned.
const origin = await verifyPlatformRequest(request);
```

A webhook with `webhook.auth: "platform"` that verifies the platform's
raw-body signature must accept `via: 'app'` too, or relayed calls fail. A
relayed request is signed over its method and path, not its body, so the body
streams without a size limit.

A task run another App started has `currentTaskRun()?.callerAppId`. Its run
record shows the actor `app:<id>`.

Never trust the `x-hatch-caller-app` header by itself; use these helpers.
