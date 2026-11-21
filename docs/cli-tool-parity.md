# App and Workflow Tool / CLI capability parity

All methods below use Connect RPC under `/api/rpc/hatch.platform.v1`, except
source transfer, which uses Git smart HTTP under `/api/git` (see below).
Tools remain available, and every
valid native session, API key or Run JWT has full public authority. The shared
contract and SDK are shipped with the same platform build. No database migration,
App/Workflow compatibility bump or protocol-18 wire change is required.

| Original Tool        | CLI                                     | Public API / shared behavior                                                                              |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| list_apps            | app list                                | AppService/ListApps; currentVersion, compatibility, capabilities                                          |
| get_app              | app get                                 | AppService/GetApp; full safe inspection, URLs, runtime, history                                           |
| checkout_app         | app clone / update / adopt              | GetApp, Git fetch (adopt: GetAppSource), SdkService/GetSdk, AssociateAppSession; frozen preparation       |
| create_app           | app create                              | AppService/CreateApp; template, pin, directory, SDK, ID/slug/path/recovery                                |
| deploy_app           | app push / deploy                       | Git push, then AppService/DeployApp by commit; release/URLs, generation, migration approval, association  |
| rollback_app         | app rollback                            | AppService/RollbackApp; compatibility and forward-only data/source recovery                               |
| query_app_db         | app db query                            | AppService/QueryAppDb; registered DB lifecycle lock, DDL/DML, caps/cancellation; no implicit provisioning |
| query_app_kv         | app kv list/get/set/delete              | AppService/QueryAppKv; empty/large UTF-8, masking/reveal, preserve/clear secret, pagination               |
| query_app_data_table | app data-table inspect/query/mutate/sql | AppService/QueryAppDataTable; schema/counts, JSON, cursors/revision, atomic mutations, bounded SQL        |
| list_workflows       | workflow list                           | WorkflowService/ListWorkflows; liveVersion, compatibility, webhook, cronCount                             |
| get_workflow         | workflow get                            | WorkflowService/GetWorkflow; input Schema, network/triggers, runs/history/errors                          |
| checkout_workflow    | workflow clone / update / adopt         | GetWorkflow, Git fetch (adopt: GetWorkflowSource), SdkService/GetSdk; history/dirty/generation, recovery  |
| create_workflow      | workflow create                         | WorkflowService/CreateWorkflow; template, pin/directory, SDK, ID/slug/path/recovery                       |
| deploy_workflow      | workflow push / deploy                  | Git push, then WorkflowService/DeployWorkflow by commit; normalized release/triggers and generation       |
| rollback_workflow    | workflow rollback                       | WorkflowService/RollbackWorkflow; compatibility and source recovery                                       |

Source transfer and release are separate. `push` and the fetch behind `clone` /
`update` speak Git smart HTTP at `/api/git/{app|workflow}/<id>.git`; `deploy`
pushes, then calls the Deploy RPC with the commit to release (`--commit`
releases a commit already on `master` without pushing). The Tools keep the
bundle transport: `deploy_app` / `deploy_workflow` upload a bundle that the
platform fast-forwards onto `master` and then releases, and Tool checkouts keep
a local bundle as `origin`. Two deliberate deviations from the CLI rules:

- `push` and source fetch are not backed by a Connect RPC. Git is the public
  contract for source transfer; the endpoint accepts the same credentials as
  the RPCs (session token, API key or Run JWT, with no gate on credential
  type) and associates a pushing Run with its App, as deploy does.
- `git-credential get` prints the current credential although it is not a
  create or rotate command. The Git credential-helper protocol requires it;
  the command only answers for the logged-in platform URL.

CLI extends local checkout output with head/master, dirty/status,
replacedExisting/synchronizedExisting and preparation. Text and JSON modes retain
the complete result. CLI adopts only proven Agent checkout identity/history and
never modifies the original origin or resets dirty source. Empty canonical
source creates a recoverable empty Git checkout, never a second resource.

Preparation covers both build toolchains, selected by the committed lockfile
as on the platform: a `pnpm-lock.yaml` source is reproduced with the same
frozen pnpm install and the platform's pinned `typescript`/`esbuild` versions
from `SdkService/GetSdk`; a `deno.json` + `deno.lock` source keeps the Deno
preparation. The pnpm toolchain adds no command, Agent Tool, public RPC method
or CLI exception; `GetSdk` only gains tool versions and generated files.

The production HTTP/PostgreSQL suite in
`src/server/platform-api/lifecycle.integration.test.ts` calls all fifteen actual
Tools through the internal REST client and compares public CLI outputs and
resource effects. It also covers session/key/Run auth, full lifecycle, migration
approval and retained data, data commands, and PostgreSQL-observed cancellation.
Workspace concurrency/recovery cases run real child processes/Git in
`packages/hatch-cli/src/workspace.test.ts`. Existing Tool normalization and domain
security/migration regressions remain part of the unit suite. The tests require
an isolated database and a production build; a skipped suite is not evidence.

Local acceptance records should distinguish observed outputs/side effects,
programmatic quality gates, installed-package/container results, and genuinely
untested operating systems. No host credential injection/renewal, Tool removal,
Workflow run/cancel, storage/key management or durable operation service is part
of this feature.

## Notification center: CLI only, no Agent Tool

`hatch notification ...` (history, test/send/update/recall/delete/respond/retry, sources, APNs status,
destinations, webhooks, groups, routes, response routes and channels) calls
`NotificationService` and has no Agent Tool counterpart because Agent Tools
for platform capabilities are frozen: the platform Agent uses the CLI. The
service accepts sessions, API keys and Run JWTs alike, and every online CLI
command refreshes Run credentials in `packages/hatch-cli/src/main.ts`. A Run
has no user, so its group and destination sends come from source `platform`
named `Hatch Agent`. Device registration is bound to a native login session,
is mobile-only and has no CLI command. Answering from the notification itself
(`POST /api/notifications/device-response`, signed with the phone's push key)
is bound to the device as well; the CLI answers the same forms with
`hatch notification respond`, and a Run answers as `Hatch Agent`. Secrets (webhook signing secrets, channel
tokens) are printed only by the create/rotate commands that mint them.

`notification update <id>` updates content and alerts phones again by default,
including when the content is unchanged or no content flags are supplied.
`--silent` maps to `UpdateNotification.silent` and only changes content; it
requires at least one content flag. SDK and Channel updates use the same
domain service and `silent: true` option. No Agent Tool is added.

## Known gaps

`AgentService` (model catalog, Agent sessions) and `WorkspaceService`
(workspace navigation, Dashboard auto-refresh) still accept only a native user
session and have no `hatch` CLI commands. Both are pending: add their CLI
commands and remove the session-only gate in `src/server/platform-api/router.ts`
together, so Run credentials gain the same authority. `AuthService.CreateHandoff`
stays session-only because it exchanges the caller's native login session for
a browser session.
