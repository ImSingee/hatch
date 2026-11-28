# App-to-App access

An App's backend can reach another App's RPC methods, Data Tables, tasks and
webhook through the platform. The caller declares what it needs with
`appAccess` in its manifest; the target declares nothing. Authoring guidance
for Apps is in `skills/building-apps/references/app-access.md`.

## Declaration

`appAccess` is an optional list in the source manifest
(`packages/hatch-manifest/src/app-access.ts`). Each entry names a target by
immutable App id, an optional alias, and explicit grants: `rpc` methods,
`Service/*` or `*`; `dataTables.read` / `dataTables.write` table names (write
includes read); `tasks` names; `webhook` exact paths, `prefix/*` or `*`. The
field requires a backend, cannot name the App itself, and lists each target
once. It is a new optional field, so no App compatibility version changed.

The deploy rejects a target id that does not exist or is archived
(`assertAppAccessTargets`). Whether the target still exposes each item is
checked per call; `appAccessOverview` reports it for the manage page and
`hatch app get` (`ops.appAccess`).

## Relay

`/api/app/<caller>/access/<target>/<kind>/<rest>`, where `<target>` is the id
or alias and `<kind>` is `rpc`, `data`, `tasks` or `hook`
(`src/server/apps/runtime-api/access/`).

1. Requests with `cookie`, `authorization` or `x-api-key` are refused (403):
   frontends and platform credentials cannot use the relay.
2. The caller signs `x-hatch-signature = HMAC(callerSecret,
   "<ts>.<callerId>.<METHOD> /<target>/<kind><rest><query>")` with
   `x-hatch-timestamp` (±5 minutes). The body is not signed, so it is never
   buffered by the relay. A bad or stale signature is 401.
3. The grant comes from the caller's **current** deployment, so a rollback
   restores the older grants. An undeclared target or item is 403.
4. The target must be deployed, supported and have the capability (404 / 503).
5. Dispatch:
   - `rpc/<package.Service>/<Method>` and `hook/<path>` forward through
     `proxyAppRequest` with the `caller` option: the body streams, and the
     target receives `x-hatch-caller-app` plus `x-hatch-caller-signature =
     HMAC(targetSecret, "<ts>.<callerId>.<METHOD> <forwarded path><query>")`
     instead of the raw-body `x-hatch-signature`.
   - `data/query` and `data/mutate` call the Data Table service for the
     target's live deployment; every table a request touches must be granted.
     Realtime events and raw SQL are not relayed.
   - `POST tasks/<name>/runs` starts a run with trigger `app` and actor
     `app:<callerId>`; the run's instance gets `HATCH_CALLER_APP`.
     `GET tasks/runs/<runId>` returns only runs that caller started.

Relay errors use `{ code, message }`; errors from the target capability keep
that capability's own response.

## Runtime

A backend whose deployment declares `appAccess` gets `HATCH_APP_ACCESS_URL`
and the platform address in its network allowlist. `@hatch/app/apps` signs
calls (`connectApp`) and verifies relayed requests on the target
(`appCaller`, `verifyPlatformRequest`, `currentTaskRun().callerAppId`).

## Security notes

- Only the caller's backend holds its signing secret. The signature binds
  time, caller, method and path, so it cannot be replayed against another
  endpoint. A captured signature could carry a different body within five
  minutes, but capturing one requires reading local traffic or the caller's
  environment, which already exposes the secret.
- Apps have no owners: every App is shared by the instance's users, and a
  target's capabilities are already open to every signed-in user, so the
  caller's declaration is the only consent required.
- Not covered: an App's web frontend shares the platform origin and can still
  call another App's `/rpc`, `/data` or `/hook` with the user's cookie, as
  before this feature. Closing that needs per-App origins.
