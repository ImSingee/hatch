# App tasks

Read this reference when an App needs background work with run history: a
scheduled job, a webhook-triggered automation, or a button that runs something
heavy. A task is a unary RPC method of the App's backend that the manifest
marks as runnable. Hatch gives every task:

- a run form generated from the method's request message,
- manual, cron, webhook and backend-enqueued runs,
- one fresh backend instance per run, killed on cancel or after 5 minutes,
- recorded steps, logs, input and output in the App's Tasks pages and the CLI,
- a concurrency cap and a queue.

Prefer a task over an RPC cron job when the work needs an input form, step
records or isolation from the App's serving instance. Keep RPC cron jobs for a
long-running backend that must act on its own in-memory state.

## Manifest

```ts
capabilities: { backend: true, tasks: true },
backendMode: 'serverless',
rpc: { proto: 'proto/service.proto', service: 'app.v1.DigestService' },
tasks: {
  concurrency: 4, // optional: runs at once across the App (1-32, default 4)
  definitions: [
    {
      name: 'digest', // lowercase letters, digits, hyphens; not "runs"
      method: 'RunDigest', // unary method on rpc.service
      title: 'Star digest', // optional, shown in the UI
      description: 'Collects a digest for one repository.', // optional
      concurrency: 1, // optional: this task's own cap, at most tasks.concurrency
      cron: [
        { name: 'daily', schedule: '0 9 * * *', input: { repo: 'denoland/deno' } },
      ],
      webhook: true, // optional: expose /api/app/<id>/tasks/<name>/run
    },
  ],
},
```

- `tasks` requires `backend`, `backend.entry` and `rpc`, and only works with
  `backendMode: "serverless"`. Each run boots the backend again, so a
  long-running backend's background loops would run once more per run.
- Deploy checks that each method exists and is unary, converts its request
  message into the input schema, and validates every cron `input` against it.
- Tasks use the backend's `network` and `extraPermissions`; there is no
  separate declaration.

## Request message and form

The request message is the run input, in protobuf JSON form: JSON field names
(`delay_ms` becomes `delayMs`), enum value names, 64-bit integers as decimal
strings, `google.protobuf.Timestamp` as RFC 3339 text and
`google.protobuf.Duration` as `"1.5s"`. Field comments become form help text.
`oneof`, `map`, `google.protobuf.Struct`/`Any`/wrappers and recursive messages
are rejected at deploy.

Shape the form and the platform's validation with the field options the
platform materializes in `.hatch/proto`. Add `.hatch/proto` as a second module
in `buf.yaml`, in the same commit that first imports the options (buf rejects a
module directory without `.proto` files, so add it only once the App uses
them), then import the options:

```yaml
modules:
  - path: proto
  - path: .hatch/proto
```

```proto
import "hatch/app/v1/options.proto";

enum Mode {
  MODE_UNSPECIFIED = 0;
  MODE_FAST = 1 [(hatch.app.v1.enum_value) = { title: "Fast" }];
}

message RunDigestRequest {
  // Repository as owner/name.
  string repo = 1 [(hatch.app.v1.field) = {
    required: true
    pattern: "^[^/]+/[^/]+$"
    placeholder: "denoland/deno"
  }];
  int32 limit = 2 [(hatch.app.v1.field) = { default: "20", min: 1, max: 100 }];
  string notes = 3 [(hatch.app.v1.field) = { title: "Notes", multiline: true }];
  Mode mode = 4;
}
```

Field options: `title`, `placeholder`, `default` (JSON text, so quote strings:
`"\"main\""`), `required`, `min`/`max` (numbers), `min_length`/`max_length`/
`pattern` (strings; `pattern` is a JavaScript regular expression) and
`multiline` (strings). Enum values take `title`. Never edit or commit
`.hatch/`; create and checkout refresh it.

The platform validates input against the schema and fills declared defaults
before every run, whatever the trigger; invalid input becomes a failed run
that never starts. When the frontend calls the same method as a normal RPC,
none of this applies: validate in the handler if the frontend calls it too.

## Handler

```ts
import { log, step, verifyTaskRequest } from '@hatch/app/tasks';

router.service(DigestService, {
  async runDigest(req, context) {
    const run = await verifyTaskRequest(context.requestHeader);
    if (!run) throw new ConnectError('tasks only', Code.PermissionDenied);
    const data = await step(
      'fetch',
      async () => {
        const res = await fetch(`https://api.github.com/repos/${req.repo}`);
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        return res.json();
      },
      { retry: { maxAttempts: 3, backoffMs: 500 } }, // exponential, factor 2
    );
    log(`stars: ${data.stargazers_count}`);
    return { stars: data.stargazers_count };
  },
});
```

- Return value: the response message becomes the run output (up to 1 MiB; a
  larger response is stored as a truncated preview); a Connect error fails the
  run with its code and message.
- `step(name, fn, { retry })` records each attempt (start, end, output or
  error) in the run inspector. Wrap meaningful units of work in it. Outside a
  task run it only runs and retries `fn`.
- `log(...)`, `console.log` and stderr go to the run log.
- `verifyTaskRequest(headers)` returns `{ runId, task, trigger }` when the
  platform started the call, else null. Task methods are also reachable as
  normal RPCs; check it in methods that must only run as tasks.
- `isTaskRun()` and `currentTaskRun()` tell module code whether this instance
  serves a task run (`HATCH_RUN_ID` and `HATCH_TASK` are set).

## Starting runs from backend code

```ts
import { enqueueTask } from '@hatch/app/tasks';

const { runId, status } = await enqueueTask('digest', {
  repo: 'denoland/deno',
});
if (status === 'failed') {
  // The input did not fit the task; nothing was queued. Inspect the run.
}
```

The call returns once the run is recorded (trigger `app`): `status` is
`queued`, or `failed` when the input was rejected (the run then never starts).
It cannot start another App's tasks.

## How runs execute

- Each run starts a new instance of the active deployment, sends one request
  and stops the instance. Module-level startup code runs once per run.
- At most `tasks.concurrency` runs execute at once (and at most a task's own
  `concurrency` for that task). Others stay queued in order; an App holds at
  most 100 queued runs, and further triggers are refused with 429.
- A run that waits in the queue starts on the deployment active when it
  starts. The run records the input as sent; it is validated again against
  that deployment's task when the run starts, which fills that deployment's
  defaults, and input that no longer fits fails the run. A deploy, rollback
  or stop does not cut a running run short within the platform's drain
  timeout (`HATCH_APP_DRAIN_TIMEOUT_SECONDS`, 300 seconds by default): its
  instance finishes the run on the old deployment, then exits. If the new
  deployment migrated the Data schema, the old code's Data Table calls fail
  with 409 and the run fails.
- Cancel, the 5-minute limit, a force stop, archive and delete kill the
  instance. A platform restart fails runs that were running and starts queued
  runs again.

## Triggers

- Manual: the App's Tasks pages, or `hatch app task run <app> <task>
  [--input <json> | --file <path|->] [--wait]`.
- Cron: `cron` entries on the task, each with a fixed `input`.
- Webhook: with `webhook: true`, `POST` a JSON body (or `GET` with query
  parameters) to `/api/app/<id>/tasks/<name>/run`, authenticated like the App
  webhook in `platform` mode: an API key or bearer token, the App's webhook
  secret (`x-hatch-secret` or `?secret=`, shown on the task page; `hatch app
  task rotate-webhook-secret <app>` mints a new one and prints it once), or a
  same-origin session. It answers `202 { runId, status }`.
- Backend: `enqueueTask` above.

## Inspecting runs

```sh
hatch app task list <app> --json
hatch app task runs <app> --task digest --status failed --json
hatch app task get-run <app> <run-id> --json
hatch app task cancel <app> <run-id> --json
```

Users see the same data on `/app/<slug>/tasks`. A frontend-less App with tasks
opens there directly.
