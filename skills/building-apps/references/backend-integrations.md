# Backend integrations

Read this reference for backend RPC, cron, webhook, long-running processes, or
calling top-level Workflows.

## Deno Fetch/Connect backend

For a manifest declaring `backend.runtime: "deno-serve"`, the platform starts the
bundled backend with `deno serve` and owns its loopback listener. Default-export
a Fetch handler; do not call `listen()` or read `PORT`. The platform injects
`DATABASE_URL` only when the database capability is enabled and a deployment
has provisioned the database. Import generated code with an explicit `.ts`
extension.

```ts
import { createConnectRouter, type ConnectRouter } from '@connectrpc/connect';
import { compressionBrotli, compressionGzip } from '@connectrpc/connect-node';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { TodoService } from '../gen/service_pb.ts';

function routes(router: ConnectRouter) {
  router.service(TodoService, {
    async list() {
      return { todos: [] };
    },
  });
}

function createConnectFetchHandler(
  registerRoutes: (router: ConnectRouter) => void,
) {
  const router = createConnectRouter({
    acceptCompression: [compressionGzip, compressionBrotli],
  });
  registerRoutes(router);
  const handlers = new Map(
    router.handlers.map((handler) => [
      handler.requestPath,
      createFetchHandler(handler, { httpVersion: '1.1' }),
    ]),
  );
  return async (request: Request): Promise<Response> => {
    const handler = handlers.get(new URL(request.url).pathname);
    return handler?.(request) ?? new Response('Not found', { status: 404 });
  };
}

const handleRequest = createConnectFetchHandler(routes);
export default {
  fetch: handleRequest,
} satisfies Deno.ServeDefaultExport;
```

This Fetch bridge supports Hatch's Connect and gRPC-Web traffic, including
streaming responses. Native gRPC is not part of the App backend contract because
the Fetch `Response` API cannot represent HTTP trailers.

### Self-listening backend

For `backend.runtime: "deno-run"` or an omitted runtime, Hatch starts the backend
with `deno run` and injects `PORT`:

```ts
import http from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';

const port = Number(Deno.env.get('PORT') ?? '8080');
http.createServer(connectNodeAdapter({ routes })).listen(port, '127.0.0.1');
```

To switch to Fetch, replace the self-listening adapter with the default export
above and select `backend.runtime: "deno-serve"` in the same source change.
Preserve `compatibilityVersion`. Register `compressionGzip` and
`compressionBrotli` as shown to retain compressed Connect and gRPC-Web traffic,
refresh the lockfile when dependencies change, validate, and redeploy. Upgrade
all serving platform processes before deploying Apps using the new mode;
older platform releases always invoke `deno run`.

Keep backend imports statically bundleable. Computed dynamic imports, separate
worker entries, npm native addons, and packages that expect unpackaged
source-relative resources are unsupported. FFI via `Deno.dlopen` can use an
explicitly authorized `backend.extraPermissions` flag such as
`--allow-ffi=backend/assets/library.so`; host commands/sidecars require scoped
`--allow-run` and a reviewed host executable or packaged asset. Relative paths
resolve from the artifact directory. These permissions must be strictly
necessary: use network, storage, KV, Data Tables, Workflow calls, or JS/Wasm
instead whenever possible. Before writing or deploying any such declaration,
explain the exact flags, necessity, and host-access risks and obtain explicit
user authorization; repeat this for every addition, broadening, or modification.
Apps and the platform share the same OS user, so these permissions can expose
platform credentials and other Apps' data.

## Invoking a deployed backend

Use the current CLI profile or complete environment credentials to call a deployed
App method without local generated stubs:

```sh
hatch app invoke backend my-app app.v1.TodoService/ListTodos --json
hatch app invoke backend my-app app.v1.TodoService/CreateTodo --file request.json --json
```

Backend invocation uses the existing `/api/app/<id>/rpc/<Service>/<Method>`
Connect endpoint and unary JSON. The default request is `{}`; `--file <path|->`
reads valid JSON while preserving its original bytes and meaningful JSON values.
It accepts native Better Auth session credentials, user API keys or live Run JWTs.
Explicit keys take precedence over Bearer credentials, then Cookie; an invalid
explicit credential cannot fall back. Platform credentials are stripped before
App code and the platform signs exact raw request bytes with the App HMAC key.
Connect code, HTTP status and structured error details remain available in CLI
JSON failures with platform credentials redacted.

The CLI refuses streaming/non-JSON protocols and redirects and never retries;
a timeout or cancellation may follow an App mutation. Direct Connect/gRPC-Web
clients retain binary, compressed and streaming support through the runtime.
Use `hatch app invoke webhook` below for plain HTTP/raw-byte handlers.

## Cron

For new scheduled work prefer [tasks](tasks.md): a cron entry on a task gets an
input, step records, run history and its own instance. RPC cron jobs below
call the serving instance and fit a long-running backend that acts on its own
in-memory state.

Enable `cron` and `backend`, then declare a proto RPC method for each job. The
method must exist on the service named by `rpc.service`.

```json
{
  "capabilities": { "backend": true, "cron": true },
  "rpc": {
    "proto": "proto/service.proto",
    "service": "app.v1.MaintenanceService"
  },
  "cron": [
    { "name": "cleanup", "schedule": "0 3 * * *", "method": "RunCleanup" }
  ]
}
```

Scheduled methods are also reachable through the user RPC proxy, so authenticate
the cron call. The platform injects `HATCH_SIGNING_SECRET` and sends:

- `x-hatch-cron`: job name
- `x-hatch-timestamp`: Unix milliseconds
- `x-hatch-signature`: `sha256=<hex HMAC-SHA256(timestamp + "." + jobName)>`

Reject missing headers, timestamps outside a short replay window, and signatures
that do not match in constant time.

Regular platform-proxied RPC calls are also signed. Their HMAC payload is
`<timestamp>.<rawBodyBytes>`, so sensitive RPCs can verify that the caller passed
through the platform.

## Webhook

Enable both `webhook` and `backend`. Requests to the public
`/api/app/<id>/hook` endpoint and its subpaths are forwarded to
`/__webhook/...` as plain HTTP.

Select the platform auth mode in the top-level manifest block:

```json
{ "webhook": { "auth": "platform" } }
```

- `platform`: accepts the existing App webhook secret or native platform
  credentials (Better Auth Cookie/Bearer session, user API key in `x-api-key`,
  or live Run JWT in Bearer). The platform verifies them and signs the forwarded
  raw body with `HATCH_SIGNING_SECRET`; verify the HMAC over
  `<timestamp>.<exact raw body bytes>` (empty bytes for GET/HEAD).
- `none`: no platform authentication and no platform signature. Invalid incoming
  Authorization/x-api-key values are ignored and stripped. The App must verify
  its own provider signature or dedicated private token; possession of a
  platform credential does not bypass that check.

Both modes strip Authorization and x-api-key, in all casing, as well as
Cookie, `x-hatch-*` and forwarding/hop-by-hop headers. `auth: none` does not mean
full header passthrough. Authorization and x-api-key cannot implement App-private
or third-party authentication. Use a dedicated nonreserved header such as
`X-App-Token` or a provider signature header, or a signature over the raw body.
Removed values are not copied to another header.

When other services call this webhook, describe its request contract in an
external doc (see External docs in the `building-apps` Skill). Skip the doc when
the webhook only serves the App itself, as in the media case below.

## Serving media from a webhook

A webhook response is streamed back to the caller, so the App can serve files
from `STORAGE_DIR` (video, audio, images, and downloads) on `/__webhook/...`.
The platform forwards `Range`, `If-Range`, `If-Match`, `If-None-Match`,
`If-Modified-Since`, and `If-Unmodified-Since`. It asks the backend for
`Accept-Encoding: identity` and does not compress or decompress the body.
Implement ranges on the raw file bytes.

- `200` with `Accept-Ranges: bytes` for the whole object.
- `206` with `Content-Type`, `Content-Range`, and `Content-Length` for a
  satisfiable range.
- `416` with `Content-Range: bytes */<size>` when the range cannot be
  satisfied.
- `304` with no body when `ETag` or `Last-Modified` matches.
- `HEAD` with the same headers `GET` would send and no body.

`Content-Disposition`, `Cache-Control`, `ETag`, `Last-Modified`, `Expires`,
and `Vary` are forwarded. `Content-Encoding` is forwarded only when the App
itself sent an encoded body; do not gzip a byte range.
`X-Content-Type-Options: nosniff` is forwarded when that is the value.
`Set-Cookie`, CORS, CSP, HSTS,
COOP/COEP/CORP, and `Location` are not. An `auth: none` URL can be opened by a
browser or an external player such as VLC or IINA, because those clients send
`Range` without platform credentials. `auth: platform` still requires a
platform credential on every request, which those players do not send.

In platform mode credential selection is fail-closed: explicit `x-api-key`
wins over Authorization (Bearer session or Run JWT), with no Cookie/secret
fallback on failure. Otherwise `x-hatch-secret` wins over `?secret=` (even an
empty header wins). The `secret` query parameter is removed only when it actually
authenticated the request. With no explicit credential or secret, a valid Cookie
session requires trusted Origin or positive same-origin browser fetch metadata;
cross-site and missing-origin/missing-metadata Cookie calls are denied, including
GET. Native callers should use explicit credentials. No CORS access is added.

Invoke through the existing endpoint using the CLI's current profile or complete
environment credentials, without reading the App webhook secret:

```sh
hatch app invoke webhook my-app --path provider/events --file payload.bin \
  --content-type application/octet-stream --header 'X-App-Token: <app-token>'
hatch app invoke webhook my-app --file - --query 'delivery=one two' --json
```

Default: POST, empty raw body, `application/octet-stream`. `--file` streams exact
file/stdin bytes. GET/HEAD reject `--file`. `--path` accepts relative segments,
not URLs, percent escapes, traversal, query or fragments; repeat `--query name=value`
for safely encoded query parameters. Repeat `--header` for nonreserved headers;
platform credential/routing/signature headers cannot be overridden. The CLI sends
platform credentials to the runtime endpoint, where they are stripped before App
code. Non-JSON output is the exact response body (use shell redirection to save
binary output). `--json` returns `ok`, `status`, `contentType`,
`bodyEncoding: "base64"`, and the base64 `body`. Non-2xx exits nonzero. Calls are
never retried and redirects are refused; a timeout may have an unknown outcome.

For a handler that streams server-sent events, subscribe with `--sse --json`:

```sh
hatch app invoke webhook my-app --method GET --path prs/123/events --sse --json \
  --max-duration 600
```

It prints one NDJSON line per event (`{"type":"event","event","id","data"}`,
`data` as the raw string) between an `open` and an `end` record. `--timeout`
then bounds only the wait for headers; `--idle-timeout` (default 120s) fails
after that long without bytes, so have the handler send a `: ping` comment at
least every 30 seconds. On `stream_idle_timeout` or `stream_interrupted`, resume
with `--header 'Last-Event-ID: <details.lastEventId>'`; the CLI never
reconnects by itself.

Preserve exact raw bytes when verifying signatures; decoding and re-encoding a
binary or non-canonical body changes the HMAC input. For example, in `none` mode
verify a provider's `X-Provider-Signature` against `await request.arrayBuffer()`
or compare `X-App-Token` with your App-owned secret before processing. Keep these
checks in place when the caller also supplies a platform key.

In a `"deno-serve"` backend, route the webhook before the Connect handler:

```ts
const connect = createConnectFetchHandler(routes);

async function handleRequest(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith('/__webhook')) {
    // Authenticate according to the selected mode, then handle the request.
    return new Response('ok');
  }
  return connect(request);
}

export default {
  fetch: handleRequest,
} satisfies Deno.ServeDefaultExport;
```

## Notifications

Enable `notifications` and `backend`, then declare the kinds the App pushes
and/or `destination` to let users route notifications to this App. Routes in
Settings → Notifications decide which notifications reach which devices,
webhooks or App destinations; the App never chooses recipients. You can inspect
and change them with `hatch notification ...` (for example `group list`,
`destination list`, `route create`) when the user asks.

```json
{
  "capabilities": { "backend": true, "notifications": true },
  "notifications": {
    "kinds": [
      { "kind": "order.shipped", "name": "Order shipped" },
      {
        "kind": "order.failed",
        "name": "Order failed",
        "description": "Payment or fulfilment failed"
      }
    ],
    "destination": {
      "description": "Forwards notifications to Slack",
      "lifecycleEvents": true,
      "responses": true
    }
  }
}
```

A kind is 1-64 lowercase letters, digits, `.`, `_` or `-`; names are shown to
users. Keep existing kinds stable: users' routes reference them, and pushing a
kind the live deployment no longer declares fails with 422.

### Pushing

```ts
import { notify } from '@hatch/app/notifications';

await notify({
  kind: 'order.shipped',
  title: `Order ${order.id} shipped`,
  body: 'Arrives Thursday',
  url: 'https://tracking.example.com/123',
  data: { orderId: order.id },
  dedupeKey: `shipped:${order.id}`,
});
```

`notify` POSTs to `HATCH_NOTIFICATIONS_URL`, signed with
`HATCH_SIGNING_SECRET`; both are injected only when the capability and backend
are enabled. Title is required (≤200 characters); body ≤4000; `url` must be
an absolute URL a device can open: a web page, another app by its own scheme
(`mailto:`, `tel:`, `slack://…`), or a Hatch deep link such as
`hatch://app/<slug>#/orders/42` (the instance web path after `hatch://`),
which phones open natively and the web opens on the instance (`javascript:`,
`data:`, `blob:`, `file:` and `about:` are rejected). Prefer a deep link for Hatch pages: the backend
does not need the instance origin. Tapping a notification with a `url` on a
phone opens that URL (a deep link opens the page in the Hatch app) instead of
the notification; pass `autoOpenUrl: false` when the link is only a reference
and the notification itself should open (`autoOpenUrl: true` without `url` is
rejected); `priority` is `-2`, `-1`, `0` (default) or `1` (see below);
`data` is a JSON object ≤32 KiB; the request body is capped at 64 KiB. A repeated `dedupeKey` returns the first notification with
`deduplicated: true`. Errors throw `NotificationError` with the HTTP status.
Pushing returns once the notification is stored; delivery happens afterwards
with retries, so never wait for or retry delivery yourself.

`priority` decides how phones present the notification; webhook and App
destinations receive every priority:

- `1` high: time-sensitive, shown even during Focus and Do Not Disturb. Use it
  only when someone should act now (a failed payment, an outage), not for
  routine updates.
- `0` normal: the default; omit the field.
- `-1` low: arrives quietly, with no sound and no banner.
- `-2` lowest: never pushed to phones; it is only listed in the notification
  history and still reaches webhook and App destinations. Do not combine it
  with a `reply` form someone must answer soon: nobody is alerted.

Any other value, including Pushover's emergency `2`, is rejected with 400.
Priority cannot be changed by `updateNotification`.

### Editing and recalling

Keep the `id` that `notify` returns when the App may later correct or
withdraw the notification:

```ts
import {
  notify,
  recallNotification,
  updateNotification,
} from '@hatch/app/notifications';

const { id } = await notify({ kind: 'order.shipped', title: 'Order shipped' });
await updateNotification(id, { title: 'Order delivered', body: null });
await recallNotification(id);
```

`updateNotification` changes any of `title`, `body`, `url`, `autoOpenUrl` and
`data`. Omitted fields keep their value; `null` clears `body`, `url` or
`data`. Phones replace the shown notification in place and alert again by
default, even if the content is unchanged. Pass `silent: true` to only change
content, or `{}` to repeat the alert with current content. Destinations that
take edits receive `hatch.notification.updated` with envelope `silent` telling
them whether to alert. `recallNotification` removes it from phones, and destinations that have
not received it yet never will. An App can only change notifications it pushed
itself (others answer 404). Editing a recalled notification throws
`NotificationError` with status 409. Repeating a recall changes nothing. Both
return `{ id, revision, recalled, changed }`.

### Asking for an answer

A notification can carry a `reply` form that people answer once: on the phone
(straight from the notification when the form is one required `buttons` or
`text` field), in the Hatch app, on the web or with the CLI. Whoever answers
first wins, and the answer cannot change.

```ts
const { id } = await notify({
  kind: 'deploy.approval',
  title: 'Deploy v2.4 to production?',
  data: { deployId: deploy.id },
  reply: {
    fields: [
      {
        id: 'decision',
        type: 'buttons',
        label: 'Approve the deploy?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject', destructive: true },
        ],
      },
    ],
  },
});
```

Field types: `buttons` (a single choice shown as buttons, 1-4 options, labels
≤32 characters), `single` and `multiple` (2-50 options; `multiple` takes
`minSelected`/`maxSelected`), and `text` (`placeholder`, `multiline`,
`maxLength` ≤4000). Use up to 10 fields with unique lowercase ids (letters,
digits, `_`); `required` defaults to `true`. An invalid form throws
`NotificationError` (400) naming the field, for example
`reply.fields.0.options: buttons fields need 1-4 options`. The form cannot be
edited later; recall the notification to close it. With a form, a phone tap
opens the form unless `autoOpenUrl: true`.

The App does not pick where answers go. Users add response routes (Settings →
Notifications, or `hatch notification response-route create`) that send
answers to a webhook or to an App destination that declares
`"responses": true`. To receive answers to the App's own questions, declare
`destination.responses`, and tell users to add a response route to this App.
Put whatever the App needs to correlate the answer in `data`.

### Receiving as a destination

Declaring `destination` adds the App to the notification destinations users
can select. Routed notifications, and ones a user sends straight to the App,
arrive as `POST /__notification` with a JSON envelope that includes the source
(`type` `app`, `channel`, `platform` or `user`, with its id, slug and name), kind,
title, body, url, `autoOpenUrl`, `priority`, data, dedupe key and timestamps. The handler may do anything
with it (ignore it, forward it to another service, store it). Return 2xx when
handled; optionally return a free-form `result` string (≤2000 characters) that
users see in the notification history. Non-2xx, timeouts (30 s) and network
failures are retried with backoff up to 6 attempts; 4xx other than 408/429 fail
immediately. The same `deliveryId` can arrive more than once, so make handling
idempotent. An App never receives notifications it pushed itself, but response
routes may send it answers to its own questions.

With `"lifecycleEvents": true` on `destination`, the App is also told when a
source edits or recalls a notification it already received:
`type` is `hatch.notification.updated` or `hatch.notification.recalled`, and
`notification` carries the current state with `revision`, `editedAt` and
`recalledAt`. Several quick edits may arrive as one event. Handle events by
`(notification.id, revision)` and ignore a revision lower than one already
handled. Without the flag only `hatch.notification` arrives. Switch on
`envelope.type` whenever the flag is set.

With `"responses": true`, response routes may send the App
`hatch.notification.responded`. `notification.reply` is the form, with every
default filled in, and `notification.response` the answer:
`{ answers, respondedBy: { userId, name }, via, respondedAt }`. `answers` is
keyed by field id: an option id for `buttons` and `single`, a list of option
ids for `multiple`, the text for `text`. Unanswered optional fields are
absent. Each notification has exactly one answer, so handle it once per
`notification.id`.

Always verify the platform signature (HMAC over `<timestamp>.<raw body>`):

```ts
import {
  NotificationVerificationError,
  notificationResult,
  verifyNotificationRequest,
} from '@hatch/app/notifications';

if (new URL(request.url).pathname === '/__notification') {
  try {
    const { type, notification } = await verifyNotificationRequest(request);
    if (type === 'hatch.notification.responded') {
      const decision = notification.response?.answers.decision;
      await recordDecision(notification.data?.deployId, decision);
    } else if (type === 'hatch.notification.recalled') {
      await deleteSlackMessage(notification.id);
    } else {
      await upsertSlackMessage(notification);
    }
    return notificationResult(`forwarded to #ops`);
  } catch (error) {
    if (error instanceof NotificationVerificationError) {
      return new Response('unauthorized', { status: 401 });
    }
    throw error;
  }
}
```

In a `"deno-serve"` backend route `/__notification` before the Connect handler,
like `/__webhook`.

## Long-running mode

Set `backendMode: "long-running"` for in-memory state, WebSockets, or background
loops. Hatch starts it at deploy and restarts it after an exit.

The default `serverless` mode starts an instance on demand, reuses it while
requests keep arriving, and stops it once no request has been in flight for the
idle timeout (5 minutes by default). In-memory state, timers, and background
work do not survive that stop, so keep state in the database, KV, Data Table,
or storage. An idle stop sends `SIGTERM` and allows about 5 seconds before
`SIGKILL`. A request that arrives while an instance is shutting down is served
by a new instance right away, so two instances of one App can overlap briefly;
do not assume a single process owns a storage file.

## Deploys, rollbacks, and stops do not interrupt requests

A deploy, rollback, restart, or stop retires the running instance instead of
killing it. In both modes the retired instance receives no further requests,
finishes the ones it already holds, and then gets `SIGTERM` (about 5 seconds
before `SIGKILL`). Requests still open when the platform drain timeout
(5 minutes by default) elapses are ended the same way: `SIGTERM` first, so
shutdown code still runs. New requests go to an instance of the new
deployment right away. Archiving or deleting an App, and a forced stop, kill
every instance at once.

Design for that overlap:

- While a retired instance still holds a request, the old and the new
  deployment run side by side. Background loops, pollers, and queue consumers
  of a long-running backend can therefore run twice for that time; make them
  idempotent or guard them with a KV or database lease. Treat `SIGTERM` as the
  signal to stop background work and release such a lease.
- Old code keeps Data Table access only when the new deployment left the Data
  schema unchanged. After a schema migration its Data Table calls fail with
  409, so the request it was serving fails instead of writing through an
  outdated schema. A Data Table call made while a deployment is being
  activated waits briefly for it to finish.
- The App database (`DATABASE_URL`), KV, and storage are shared by both
  deployments with no such check. Keep changes to their layout compatible with
  the previous deployment, or migrate in two deploys.

Inspect and control the runtime with the CLI:

```sh
hatch app backend status my-app --json
hatch app backend restart my-app --json
hatch app backend stop my-app --json
```

`status` reports `state`, `keepAlive`, `lastError` (the most recent start
failure) and `drainingInstances`, the number of retired instances still
finishing requests. `stop --force` and `restart --force` kill instances
immediately and fail their in-flight requests; use them only when a drain must
not be waited for.

## Calling top-level Workflows

Apps call Workflows created in the Workflow module; they do not define
Workflows themselves. Use `list_workflows` and copy each target's exact
`id` into `workflow`; a Workflow slug does not resolve here. Add a readable
`alias` for the stable key used by backend code:

```json
{
  "workflows": [
    {
      "workflow": "01k43s9az5t2qpy7ejf0hm6vwc",
      "alias": "dailyDigest"
    }
  ]
}
```

Each target must already be deployed with its webhook trigger enabled. The
platform injects `HATCH_WORKFLOWS`, a JSON map from alias (or the Workflow id
when no alias is declared) to
`{ workflow, name, url, secret }`.

```ts
type WorkflowTarget = {
  workflow: string;
  name: string;
  url: string;
  secret: string;
};

const workflows = JSON.parse(Deno.env.get('HATCH_WORKFLOWS') ?? '{}') as Record<
  string,
  WorkflowTarget
>;

async function callWorkflow(alias: string, input: unknown) {
  const workflow = workflows[alias];
  if (!workflow) throw new Error(`Workflow ${alias} is unavailable.`);
  const response = await fetch(workflow.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hatch-secret': workflow.secret,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Workflow returned ${response.status}.`);
  return (await response.json()) as { runId: string; status: string };
}
```

The call enqueues a run and returns without waiting for completion. Keep the
injected registry and secret in backend code; never send them to the frontend.
