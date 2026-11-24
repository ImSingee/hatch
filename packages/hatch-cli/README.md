# Hatch CLI

Authentication, App source lifecycles and App data operations, over the
public Connect RPC contract at `/api/rpc`. Requires Node >=26, Git and pnpm.
A source that builds with the pnpm toolchain (`pnpm-lock.yaml`) needs pnpm of
the same major version as the platform's, currently 12. Deno is needed to
prepare a Deno-toolchain source (`deno.json` + `deno.lock`) and to run or test
authored App code locally. No platform repository checkout,
current-working-directory dependency, or runtime npm dependencies are needed by
the CLI executable.

## Build and install

```sh
pnpm build                  # Platform, Runner, SDKs and CLI
pnpm --dir packages/hatch-cli pack --out dist/hatch-cli-0.1.0.tgz
# In an independent directory:
pnpm add /path/to/hatch-cli-0.1.0.tgz
pnpm exec hatch help
```

`pnpm cli ...` runs source in this repository. The private package is not
published. `scripts/build-cli.ts` bundles the pure contract and client, and
rejects server-only imports in its build graph. The production Dockerfile
installs `/usr/local/bin/hatch` in the shared Platform/Runner image, executable
from any workdir with Node alone. The image also provides the pinned pnpm needed
for workspace dependency installation/codegen. CLI/SDK outputs must be rebuilt
before packing. On Windows, npm-global/Corepack pnpm shims are resolved to their
Node entry point; standalone `pnpm.exe` is supported directly. Batch scripts
are never executed through a shell. `--workdir` resolves relative source and data
input paths; auth rejects it as an invalid argument.

## Login, profiles and environment credentials

```sh
hatch auth login --url https://hatch.example.com --profile personal
hatch auth login --url https://hatch.example.com --profile personal --no-browser
hatch auth status --profile personal --json
hatch auth logout --profile personal --json
```

Browser approval uses the existing `hatch-cli` device flow. Sign in with the
platform's password/passkey flow, compare the printed code, and approve. The CLI
never collects a password or imports an existing session token. `--no-browser`
prints the URL/code for another device. Polling honors pending/slow-down/expiry;
SIGINT/SIGTERM stops polling without saving. Only an online-verified ordinary
session is saved. All valid sessions, user API keys and Run tokens currently
have full public API authority; there are no CLI scopes or resource ACLs.

Create an API key in Settings using an account session, then save it locally
from a **private regular file** (0600 on Unix):

```sh
hatch auth login --url https://hatch.example.com --profile automation --api-key-file /private/key.txt
hatch auth status --profile automation --json
hatch auth logout --profile automation --local-only --json
```

`--api-key-file` accepts only an API key, verifies it with `x-api-key`, and saves
`apiKey` rather than `token`. No session-token import option exists. API key
management commands are unsupported; the CLI does not turn a key into an account
session and does not invent atomic rotation. Revoke keys in Settings.

Cloud/CI callers inject a complete pair and invoke commands directly:

```sh
HATCH_CLI_URL=https://hatch.example.com HATCH_CLI_API_KEY='<key>' hatch app list --json
HATCH_CLI_URL=https://hatch.example.com HATCH_CLI_TOKEN='<run-jwt>' hatch auth status --json
```

- `HATCH_CLI_URL` + **exactly one** of `HATCH_CLI_TOKEN`/`HATCH_CLI_API_KEY` wins.
  `token` uses Bearer; `apiKey` uses `x-api-key`. Neither is a fleet credential.
- Any present-but-incomplete, empty, whitespace, ambiguous, invalid, expired or
  revoked env credential fails without profile/Cookie fallback. Env plus an
  explicit `--profile` is rejected. URL and credential never mix across sources.
- Env mode never reads/writes CLI credential config, persists tokens, or opens a
  browser. `auth login/logout` rejects externally managed env credentials.
- Otherwise choose explicit `--profile`, active profile, or the sole profile.
  Profiles bind an origin and one credential. The current server has no stable
  instance ID. Requests never follow redirects; device links must be same-origin.
- HTTPS origins are required, except HTTP localhost/127.0.0.1/::1. `auth status`
  has no URL override and verifies online; it never treats local JWT decoding as
  proof. It returns only safe user/key/Run metadata, authority and expiry (null
  for a nonexpiring key), plus source/profile/origin.
- Run JWTs stay in env and are rejected in config. Only the trusted fleet can
  mint/renew them via `/internal/api/runs/:runId/token`; the CLI never reads,
  stores or uses `AGENT_RUNNER_TOKEN`. Host injection/renewal remains outside
  this change. Run status, binding, lease and expiry are checked by the server.

Default config: macOS `~/Library/Application Support/Hatch/cli/config.json`,
Linux `${XDG_CONFIG_HOME:-~/.config}/hatch/cli/config.json`, Windows
`%APPDATA%\Hatch\cli\config.json`. Override with `--config <path>`:

```json
{
  "version": 1,
  "activeProfile": "personal",
  "profiles": {
    "personal": {
      "url": "https://hatch.example.com",
      "token": "<private-session>"
    },
    "automation": {
      "url": "https://other.example.com",
      "apiKey": "<private-key>"
    }
  }
}
```

Credentials are plaintext: keep config private and outside Git. Files must be
regular, nonsymlink, Unix-owner-only; use a private user ACL on Windows. Writes
lock `<config>.lock`, reread latest profiles, fsync a private temporary file, and
rename atomically. Concurrent writes fail with exit 6. Logout rechecks the exact
profile under the lock, so concurrent re-login is preserved. Default session
logout confirms `/api/auth/sign-out` before removal; failure retains the config.
`--local-only` only forgets the profile and explicitly reports `revoked:false`.
API key logout requires this option; it does not revoke the key. After a crash,
remove a stale lock only after confirming no live writer owns it.

## App lifecycle

```sh
hatch app list --json
hatch app get <id-or-slug> --json
# create.json: {"slug":"notes","name":"Notes","pin":false}
hatch app create --file create.json --directory ./notes --json
cat create.json | hatch app create --file - --workdir ./workspace --json
hatch app clone <id-or-slug> --directory ./notes-copy --json
hatch app clone <id-or-slug> --directory ./notes-copy --force --json
hatch app adopt <id-or-slug> --directory ./agent-owned-checkout --json
hatch app associate <id-or-slug> --json
hatch app update --directory ./notes-copy --json
# Edit source, then git add / git commit yourself.
hatch app push --directory ./notes-copy --json
hatch app deploy --directory ./notes-copy --message 'Release notes' --json
hatch app deploy --directory ./notes-copy --commit <full-commit-id> --json
hatch app rollback <id-or-slug> --version 1 --json
```

`--workdir` resolves relative checkout paths (default cwd); no `chdir` to the
platform repository is required. Cloud session workspace directories can be
supplied the same way. Each standalone checkout stores only origin/kind/immutable
ID/generation/source and recovery metadata in `.git/hatch-cli.json`, never
credentials. IDs resolve before slugs on the server. Subsequent operations use
the canonical immutable ID; generation is checked locally and at deployment.
A checkout whose metadata names another instance or a kind other than `app`
is rejected with `workspace_instance_mismatch`.

- **Create:** validate JSON with the public contract, register once, materialize
  the returned template into a new staged Git repository, commit the scaffold,
  record identity, and install SDK/dependencies. Existing destinations are never
  overwritten. A response/preparation failure retains its recovery workspace
  and journal; inspect the recorded request/ID and remote state before retrying.
  A created draft with metadata can resume preparation using `update`.
- **Clone:** obtain detail, fetch platform `master` over Git, validate the
  source tree, then create a new checkout whose `origin` is the platform
  remote. Empty canonical source
  initializes an empty Git workspace; missing authored inputs report the failing
  preparation stage and retain that checkout for repair. No template/resource
  is silently created. `--force` requires an explicit directory, rejects roots,
  symlink traversal and nested checkouts, and prepares before replacing. On
  preparation failure the old directory remains intact; on swap failure it is
  restored. Recoverable preparation work remains at the reported path.
- **Adopt:** validate the existing Agent origin bundle path (`app-<id>.bundle`),
  immutable ID, manifest, current platform generation and source history before
  adding CLI metadata. Local HEAD must contain platform master; dirty work and origin are
  preserved. Empty canonical source is ambiguous unless an uncommitted checkout
  belongs to the verified Run's session. Adoption never resets local history.
- **Update:** require clean source; fetch platform `master` and the platform's
  `deploy/*` tags into `origin/master`; fast-forward only when local HEAD is an
  ancestor of it. A checkout that is only ahead (unpushed commits, or commits a
  rollback moved `master` away from) is left as is and reports `state: "ahead"`.
  Diverged history is rejected with `non_fast_forward`; merge or rebase onto
  `origin/master` yourself. Nothing is ever reset.
- **Push:** push committed `HEAD` to platform `master` without releasing it.
  The platform accepts fast-forwards only; otherwise the command exits with
  `non_fast_forward`. Uncommitted changes are neither required to be absent nor
  sent. Output: `{id, commit, masterCommit, state: "pushed" | "up-to-date"}`.
- **Deploy:** require clean committed source, validate tracked managed paths,
  push `HEAD` exactly as `push` does, then release that commit with the recorded
  generation. `--commit <full-commit-id>` skips the push and releases a commit
  that is already on platform `master` (its tip or an ancestor); any other
  commit is rejected. A failed build leaves the pushed commit on `master`
  unreleased. Platform manifest ID/compatibility, build and migration policies
  remain authoritative. No compatibility/protocol bump or source defaults are
  added.
- **Rollback:** synchronous API call with a real release version; display the
  returned compatibility object and App `dataSchemaMismatch`. Data schema and
  contents are forward-only; rollback does not undo a destructive migration.
  Platform `master` moves back to the restored release. Checkouts are not
  touched: later commits stay local and return with the next push or deploy.

### Plain Git

Source moves over Git smart HTTP at
`<platform-url>/api/git/app/<id-or-slug>.git`. `master` is the source
line: it only fast-forwards and cannot be deleted. Other branches and tags are
ordinary Git refs, except `deploy/*` tags, which the platform creates for each
release. Pushing never deploys.

Checkouts made by `create` and `clone` have this remote as `origin` and use
`hatch git-credential` as its only credential helper, so `git fetch`, `git pull`
and `git push` work with the current login, including a Run credential. `hatch`
must be on `PATH`. No credential is written to the checkout; the helper entry
records only the `--config` path and `--profile` the checkout was created with. A checkout created
by an older CLI gains `origin` on its next `update`, `push` or `deploy`; an
adopted Agent checkout keeps its own `origin`, and the CLI commands still reach
the platform.

Without the CLI, any valid credential works as the HTTP Basic password (any
username), or as `Authorization: Bearer` / `X-API-Key`:

```sh
git clone https://hatch:<api-key>@platform.example/api/git/app/<id>.git
```

`hatch git-credential get` implements the Git credential-helper protocol: it
reads the request from stdin and prints the current credential to stdout, only
when the requested host is the logged-in platform. `store` and `erase` do
nothing. It exists for Git to call.

SDK preparation uses authenticated `hatch.platform.v1.SdkService/GetSdk`: compiled
`@hatch/app` and legacy `@hatch/data` payloads, import maps,
the platform-generated TypeScript configuration and the versions of the tools
the platform builds with, all from the **running platform build**. Install into
generated `.hatch/` atomically; never commit it.

The committed lockfile selects the build toolchain, exactly as it does on the
platform: `pnpm-lock.yaml` with no `deno.json`/`deno.lock` selects pnpm,
`deno.json` + `deno.lock` with no `pnpm-lock.yaml` selects Deno. A source with
files of both families, or an App with neither, fails preparation with a
message naming the files to remove.
Authored lockfiles are never rewritten, and dependency lifecycle scripts are
never run for either toolchain.

- **pnpm toolchain.** Validate `package.json` and
  `pnpm-lock.yaml` with the platform's dependency policy, then run the two pnpm
  steps the platform runs at deploy: `pnpm fetch`, then an offline frozen
  install. The registry is fixed to `https://registry.npmjs.org/`; project,
  user and global pnpm/npm configuration, install hooks and
  `pnpm-workspace.yaml` are ignored. Apps then fetch the platform's pinned
  `typescript` and `esbuild` with `pnpm dlx`, check the import graph and types
  of `manifest.ts`, bundle it, and evaluate the bundle with this machine's Node
  under `--permission` with no grants: no file, network, subprocess or worker
  access. An older Node that cannot deny network fails preparation. Node's
  permission model does not cover signals, so an evaluated manifest can still
  signal other processes of the same OS user; prepare source you do not trust
  under a separate user or in a container. Adopt evaluates a `manifest.ts`
  the same way, installing first; a `manifest.json` is parsed
  without installing anything. A pnpm of another major version fails
  preparation with a message naming the required one.
- **Deno toolchain.** Apps validate the shared dependency policy and run
  `deno install --no-config --package-json --node-modules-dir=auto --lock=deno.lock --frozen`,
  then validate the source manifest with permissions denied.

A CLI that predates the pnpm toolchain fails App preparation on a
`pnpm-lock.yaml` source with a missing-`deno.json` message; upgrade the CLI. A
platform that predates it delivers no toolchain versions, and preparation
reports that the platform does not provide the pnpm build toolchain. Both
surface as `app_preparation_failed` with the stage in the message.

A failure that says nothing about the source keeps its own code and exit 7,
during preparation and during adopt alike: `tool_unavailable` when a local tool
(`pnpm`, `deno`, `git`) cannot be run, and `local_command_timeout` when a local
command is stopped at its 300s limit. Fix the environment and retry; the source
was not judged. A Git transfer that runs out of time stays `git_remote_failed`.

App Connect codegen uses
platform-pinned Buf/protoc-gen-es through pnpm dlx and the platform-owned
`.hatch/buf.gen.yaml`, not an authored plugin configuration. Generated `gen/`,
dependencies and a pnpm-written `pnpm-workspace.yaml` are Git-excluded. Commands receive a limited child environment,
including no CLI, fleet, database or provider secrets. This is not a same-UID
sandbox: local dependency/source tooling still runs as the invoking user.

```sh
cd notes-copy
# pnpm toolchain: type-check with the platform-generated configuration, using
# the TypeScript major the platform runs. Outside the platform repository.
pnpm dlx --package typescript@7 tsc -p .hatch/tsconfig.json
# Run tests on the Deno runtime without writing a deno.lock.
deno test --no-lock --node-modules-dir=manual --import-map=.hatch/import-map.json
# Deno toolchain: check with the materialized import map.
deno check --import-map .hatch/import-map.json manifest.ts app/main.tsx
```

Workspace commands use a canonical-path hashed sibling directory lock across
processes, with an owner PID/time record. After a crash, inspect both the lock
and recovery/pending record before manually removing a stale lock. SDK/preparation
failure retains the checkout; retry `update` once repaired. Symlink/submodule/
tracked `.hatch` or `node_modules` source is rejected. No local reset/clean or
unattended authored commit is performed after scaffold creation.

## Migration approval and uncertain outcomes

A destructive App Data Table preview returns `CONFLICT` and an exact approval
token. Review the authored schema diff, then retry the same committed change explicitly:

```sh
hatch app deploy --directory notes-copy --message 'Reviewed migration' \
  --allow-destructive-data-migration --data-migration-approval-token '<exact-token>' --json
```

Both options are required together. A changed schema
or intervening data schema produces a new approval fingerprint. No automatic
approval or destructive retry is performed. Definite 4xx rejections clear the
pending marker; source/data protection is owned by existing platform services.

Create/deploy/rollback are never automatically retried. Network/5xx/cancel can
leave an unknown server outcome. Deploy fsyncs a pending commit before sending:

```sh
hatch app deploy --directory notes-copy --reconcile --json
# Only after inspecting release history and confirming the previous request ended:
hatch app deploy --directory notes-copy --retry-after-confirming '<pending-commit>' --json
```

`--reconcile` reports `source-matches-pending` when the resource's released
commit (`currentSourceCommit`) equals the pending commit, otherwise
`outcome-unresolved`. The push that precedes a release is safe to repeat.
Matching source is evidence, not proof of a deployment version or completion.
The explicit retry confirmation is recorded locally; it is not server-side
idempotency. Cancellation does not cancel a platform build already in flight.
Create/rollback uncertainty is reported for manual detail/source/release-history
inspection. No durable operation service or fake async operation IDs are added.

## Output, errors and unsupported commands

`hatch help`, `help app deploy`, `--help`, `version` and `--version` work offline.
Help lists one level at a time: `hatch help` shows the top-level commands and
groups, `hatch help app` (or `hatch app --help`, or just `hatch app`) the commands and subgroups of
`app`, and `hatch help app kv set` that one command. `--json` returns the same
level as `commands` (with usage and description) and `groups` (path, usage and
description); follow a group's `path` to list its commands.
`--json` writes a single JSON result or `{ok:false,error:{code,message}}` to
stdout; progress/device instructions use stderr. Branch on code, not prose.
Secrets are redacted; raw exception/auth response diagnostics are not printed.
Auth timeout defaults: login 600s, status/logout 15s; lifecycle requests 30s,
push and deploy 600s. Git source transfers in `clone` / `update` get 300s by
default and exactly `--timeout` when it is given. `--timeout` accepts at most
3600s; subprocess preparation is bounded. Git transfer errors: `non_fast_forward` (6), `git_remote_not_found`
(5, deleted resource or a platform without Git transport), `git_remote_failed`
(7) and `UNAUTHORIZED` (3). A platform the CLI cannot connect to (refused,
unknown host, unreachable network) is `network_error` (7) naming its URL; no
request was sent, so retrying is safe. A connection that fails or times out
after the request was sent is `outcome_unknown` (7): inspect platform state
before retrying a mutation. `app invoke webhook --sse` streams server-sent
events: `--timeout` bounds only the wait for response headers, `--idle-timeout`
(default 120s) and `--max-duration` bound the stream, and `--json` prints NDJSON
records. Its stream errors are `http_error`, `not_event_stream`,
`stream_idle_timeout`, `stream_interrupted` and `stream_event_too_large` (all
exit 7 except `http_error`, which maps 401/403/404 to 3/4/5); see
`docs/app-webhooks.md`.

| Exit | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success/help/version                                 |
| 1    | Unexpected CLI failure                               |
| 2    | Arguments/input/config/source selection              |
| 3    | Invalid/expired/revoked credential or ended Run      |
| 4    | Forbidden/denied authorization                       |
| 5    | Resource not found                                   |
| 6    | Lock/source/generation/deployment/migration conflict |
| 7    | Network/timeout/unknown outcome/tool failure         |
| 8    | Explicitly unsupported command                       |
| 130  | Cancellation; inspect any in-flight mutation         |

Operation commands and API key management remain unsupported. Platform Agent
Tools remain usable. Run credentials come from the caller; host injection and
renewal are outside this feature.

## Complete views and App data

List/detail and deploy output retain the complete public DTO in both text and
`--json` modes: compatibility, capabilities, normalized release URLs/triggers,
runtime/network state, nonsecret data metadata and deployment history. Rollback adds
warnings and source recovery instructions; forward-only data is retained.

```sh
hatch app kv list <id> --limit 10 --cursor '<nextCursor>' --json
hatch app kv get <id> <key> --reveal-secrets --json
hatch app kv set <id> <key> --file ./value.txt --secret --json
hatch app kv set <id> <key> --file - --no-secret --json
hatch app kv delete <id> <key> --json
hatch app data-table inspect <id> --table records --json
hatch app data-table query <id> --file ./query.json --json
hatch app data-table mutate <id> --file ./mutations.json --json
hatch app data-table sql <id> --file ./query.sql --statement-timeout-ms 30000 --json
hatch app db query <id> --file ./query.sql --json
```

KV set reads raw UTF-8 (including empty strings and trailing whitespace), up to
64 KiB. Omitting the secret option preserves an existing flag; `--no-secret`
clears it and new keys default nonsecret. Secrets are masked unless requested.
List retains `nextCursor`; no prefix filter exists. Limits remain 1–100.

Query JSON contains `table`, optional `where`, `orderBy`, `cursor`, `limit`;
mutation JSON contains `operations` with insert, patch (including `unset`),
increment and delete. Omit `action`; the command chooses it. Arbitrary JSON
records preserve null, empty strings/arrays/objects, false and zero. Responses
retain schema/hash/row counts, cursor/revision/truncation, atomic batch results
and per-statement SQL command/count/rows. Query limits remain 1–200 and cursors
up to 60,000 characters. Prefer structured operations; avoid raw SQL DDL,
TRUNCATE and system tables. Raw SQL has the existing domain behavior and no new
permission/parser layer.

Data Table SQL statement timeout defaults to 30,000 ms (1,000–1,800,000 allowed).
HTTP `--timeout` is separate and defaults to statement timeout plus 30 seconds.
App DB queries an already registered database under its lifecycle lock, supports
DDL/DML, never provisions/recreates a database, and uses its existing 30-second
statement timeout, 100-row display and character cap (HTTP default 60 seconds).
SIGINT/HTTP timeout abort SQL connections; possibly mutating requests are never
retried automatically. A cancellation around commit still requires inspecting
platform data before retrying.

## App tasks

```sh
hatch app task list <id-or-slug> --json
hatch app task run <id-or-slug> <task> --input '{"repo":"a/b"}' --wait --json
hatch app task run <id-or-slug> <task> --file ./input.json --json
hatch app task runs <id-or-slug> --task <task> --status failed --limit 50 --cursor '<nextCursor>' --json
hatch app task get-run <id-or-slug> <run-id> --json
hatch app task cancel <id-or-slug> <run-id> --json
hatch app task rotate-webhook-secret <id-or-slug> --json
```

A task is a backend RPC method the App's manifest marks as runnable; every run
executes in its own backend instance. `list` prints the App's `concurrency`,
`queued` and `running` totals, `available` (false when the App cannot run
tasks), and each task with `inputSchema`, `cron` (with `nextRun`),
`webhookPath`, its own `concurrency` and `latestRun`. Absent facts are `null`.

`run` takes a JSON object (`--input` or `--file`, up to 1 MB; default `{}`)
and prints `runId` and `status`: `queued`, or `failed` when the platform
rejected the input (inspect the run for the reason). With `--wait` it polls
until the run ends, writing status changes to stderr, and prints the full run.
A run that did not succeed exits 6 with `task_run_failed` or
`task_run_canceled`; with `--json` the error envelope is the only output and
carries the full run in `error.details.run`.
`--timeout` defaults to 600 seconds with `--wait` (60 otherwise); when it
expires the command exits 7 with `timeout` and the run keeps going. A full
queue answers `TOO_MANY_REQUESTS` (exit 2). `get-run` prints steps, log,
input, output and the queue position of a queued run. `cancel` is idempotent
and prints `canceled: false` with the final status for a finished run.
`rotate-webhook-secret` replaces the App's shared webhook secret, which the
App webhook and every task webhook accept, and prints `{ appId, secret }`
once; callers using the previous secret are rejected from then on. It answers
`CONFLICT` when the App has neither the App webhook nor a task webhook.

## App backend runtime

```sh
hatch app backend list --limit 50 --cursor '<nextCursor>' --json
hatch app backend status <id-or-slug> --json
hatch app backend start <id-or-slug> --json
hatch app backend stop <id-or-slug> [--force] --json
hatch app backend restart <id-or-slug> [--force] --json
```

Every command prints the backend view: `id`, `slug`, `name`, `mode`
(`serverless` or `long-running`), `runtimeSupported` and `runtime` (`state`
`running`/`starting`/`stopped`, `pid`, `port`, `startedAt`, `stoppedAt`,
`lastExitCode`, `lastExitSignal`, `lastError`, `restartCount`, `keepAlive`,
`drainingInstances`). Absent facts are `null`. Runtime facts describe the
answering platform process and are not persisted. `list` prints
`{ backends, nextCursor }` in App id order, 50 per page by default (`--limit`
1–100); pass `nextCursor` as `--cursor` for the next page. It is `null` on the
last page.

Deploy, rollback, `stop` and `restart` are graceful: the previous instance
receives no further requests and finishes the ones it holds. It is then sent
`SIGTERM` and killed 5 seconds later if it has not exited. Requests still open
when the platform drain timeout (`HATCH_APP_DRAIN_TIMEOUT_SECONDS`, default 300) elapses are ended the same way; a timeout of 0 kills retired instances at
once. `drainingInstances` counts instances in that state.
`stop` clears the keep-alive mark, so a long-running backend stays down until
it is started or deployed again; a serverless backend starts on its next
request. `--force` kills every instance at once, draining ones included, and
fails their in-flight requests; it is accepted only by `stop` and `restart`.
`start` waits until the backend is reachable; when the boot fails the command
exits 6 with code `CONFLICT` and `status` shows the reason in `lastError`. The
HTTP `--timeout` defaults to 60 seconds.

Run-authenticated App create/clone/update/deploy/rollback associate with the
verified current Agent session; `app associate` is idempotent. Ordinary sessions
and keys return `not-applicable` and create no relation. A caller cannot supply
a session ID.

See [the 9-tool comparison](../../../docs/cli-tool-parity.md). Platform and CLI
contracts/SDKs are built and released together; strict DTO validation does not
promise compatibility with older CLI binaries.

## App icons and image generation

```sh
hatch model list --kind chat --json
hatch model set-kind <model-id> --kind image
hatch image-model list --json
hatch image-model add --provider <provider-id> --model-id gpt-image-2.6-flare \
  --name 'GPT Image Flare' --description 'Fast icon drafts'
hatch image-model update <image-model-id> --description 'Line icons'
hatch image generate --model <image-model-id> --prompt-file prompt.txt \
  --subject-tile '#3E63DD' --json
hatch app icon set my-app --candidate <candidate-id>
hatch app icon set my-app --file icon.png
hatch app icon get my-app --json
hatch app icon clear my-app
hatch image-model remove <image-model-id> --yes
```

An instance can have several image models, each a provider model of the
image category with an optional description of what it suits. `model list`
shows every provider model with its `kind` (`--kind` filters, `--limit` and
`--cursor` page), and `model set-kind` moves a model between `chat` and
`image` like the Web form's Category field; `image` is refused on a provider
whose API cannot generate images.
`image-model list` prints every model with its `id`, whether it is `usable`,
the `defaultModelId` and the providers that can hold image models with
suggested model ids; `--limit` (1 to 100) prints one page of models and a
`nextCursor` for `--cursor`. `add` attaches a model to such a provider and uses its
stored API key; `update` changes only the given fields (`--clear-description`
empties the description); `remove --yes` deletes one; it cannot be undone. `image generate --model <id>`
picks the model; without it the default, the first usable model, is used.
`image generate` costs provider credit and prints the `imageModelId` used and
one candidate `id` and authenticated `path` per image; candidates expire after
one day.
`--count` (1 to 4) repeats the same prompt, so its results are close
variations; run one command per prompt to compare different designs.
Both tile flags return a finished 512 px tile on a gradient of that colour.
`--subject-tile` asks the model for a transparent background and centres the
cut-out subject at a fixed size with a soft shadow; `--glyph-tile` expects a
white glyph drawn on black. The two are mutually exclusive. `--output-dir` also writes `<id>.png`.
`app icon set` takes exactly one of `--file` (PNG, JPEG or WebP, at most 4 MB,
sides 64 to 4096 px; `-` reads stdin) and `--candidate`; the platform crops to
a centred square, re-encodes and deletes the previous icon. `clear` succeeds
when there is no icon.

Local rejections exit 2: `invalid_arguments` (missing or contradictory flags,
an empty or over-long `--prompt`, `--count` outside 1 to 4, malformed colour,
model or candidate id), `invalid_input` (not an image, or a `--prompt-file`
whose content is empty or over-long), `input_too_large`, and
`output_unwritable` when `--output-dir` cannot be created, which is checked
before any image is generated. Prompts are limited to 4000 Unicode code points.
Platform errors: `CONFLICT` (6) when no image model is usable or the chosen
one's provider is disabled or has no key,
`BAD_REQUEST` (2) carrying the image provider's reason, an image that cannot
be decoded, or `image-model add` on a provider that cannot make images,
`TOO_MANY_REQUESTS` (2) at the hourly limit of 30 images,
`NOT_FOUND` (5) for an unknown App, provider, image model or expired
candidate,
`SERVICE_UNAVAILABLE` (7) when the provider is unreachable, and
`download_failed` (7) when a generated candidate could not be saved to
`--output-dir`. With `--json` its `error.details` is the normal result:
`imageModelId`, `modelId` and every candidate with `id` and `path`, plus `file` for the ones
that were saved, so no image has to be generated again.

## Theme and pins

```sh
hatch theme get --json
hatch theme set --accent teal
hatch theme set --dock-labels
hatch pin list --json
hatch pin list --limit 20 --cursor <next-cursor> --json
hatch pin add --app my-app --label Inbox --entry /inbox
hatch pin add --app my-app --if-absent
hatch pin update <pin-id> --label 'Inbox' --clear-entry
hatch pin reorder --pin <pin-id> --pin <pin-id>
hatch pin remove --pin <pin-id>
hatch pin add --dashboard <dashboard-id>
hatch pin remove --dashboard <dashboard-id>
```

`theme get` prints the chosen `accent`, the `defaultAccent`, every accent
with its colour and `dockLabels`. `theme set` changes only the settings it is
given, for the whole instance: `--accent` replaces the accent and signed-in
clients recolour without a reload; `--dock-labels` / `--no-dock-labels` shows
or hides the names under the web dock tiles (hidden by default). Give at least
one; `--dock-labels` and `--no-dock-labels` together are rejected.

`pin list` prints App pins in navigation order (`id` is the pin id, which
`update`, `remove --pin` and `reorder --pin` take) and pinned dashboards.
Without `--limit` it prints every pin. `--limit` (1–100) pages one sequence,
App pins first, then dashboards, and prints
`nextCursor` while more entries follow; pass it as `--cursor`. An App can
have several pins: `pin add --app` always adds one and
`--if-absent` returns the existing pin instead (`created: false`). `--entry`
is the fragment the pin opens, with or without `#`. `pin update` leaves
omitted fields unchanged and `--clear-entry` makes the pin open the App root.
`pin remove --app` deletes every pin of the App and prints `removedPinIds`.
`--dashboard` only sets the pinned flag. `pin reorder` moves
the listed ids to the front in the order given, keeps unlisted ones in their
relative order after them, and prints the complete new order; `--dashboard`
orders all dashboards, pinned or not.

Local rejections exit 2 with `invalid_arguments`: an `--accent` the tokens do
not define, no target or more than one of `--app`, `--dashboard` and `--pin`, `--label`, `--entry` or `--if-absent` without `--app`,
`--if-absent` with `--label` or `--entry`, a blank `--label` or `--entry`, an
`--entry` longer than 512 characters (the platform also rejects one, never
shortening it),
`--entry` with `--clear-entry`, `pin update` with nothing to change, and a
repeated id in `pin reorder`, a `--limit` outside 1–100, a `--cursor` that
is not a printed `nextCursor`, a flag the command does not take and a flag
given without its value (the message names the flag). Platform errors: `NOT_FOUND` (5) for an unknown
App, dashboard or pin id, and `BAD_REQUEST` (2).

## Dashboards

```sh
hatch dashboard list --json
hatch dashboard list --limit 20 --cursor <next-cursor> --json
hatch dashboard get <dashboard-id> --json
hatch dashboard create --name 'Morning' --description 'What I check first'
hatch dashboard update <dashboard-id> --name 'Mornings' --auto-refresh 60
hatch dashboard update <dashboard-id> --clear-description --no-auto-refresh
hatch dashboard delete <dashboard-id> --yes
hatch dashboard widget available --json
hatch dashboard widget available --limit 20 --cursor <next-cursor> --json
hatch dashboard widget add <dashboard-id> --app my-app --widget summary
hatch dashboard widget layout <dashboard-id> <placement-id> --x 6 --w 6
hatch dashboard widget layout <dashboard-id> <placement-id> --breakpoint mobile --h 3
hatch dashboard widget remove <dashboard-id> <placement-id>
```

`dashboard list` and `dashboard widget available` print everything unless
`--limit` (1–100) asks for a
page; it then prints `nextCursor` while more follow, to pass as `--cursor`.
`dashboard get` prints the settings, the placed widgets and their `x`, `y`,
`w`, `h` in grid units for each breakpoint: `desktop` has 12 columns,
`tablet` 8 and `mobile` 4. A widget's `id` there is its placement id, which
`widget layout` and `widget remove` take. `supportedSizes` lists the only
footprints a widget accepts; empty means any size from 2×2 up. `widget add`
places a widget below the others at its default size and prints the new
`placementId`; position flags place it at one breakpoint instead, and the
other breakpoints follow. `widget layout` changes one breakpoint (desktop
unless `--breakpoint` is given) and keeps omitted numbers; widgets under the
new position move down and empty rows close up, so read the printed layouts.
`update` leaves omitted fields unchanged; `--auto-refresh` takes seconds
(1 to 3600). Pin, unpin and reorder dashboards with `hatch pin`.

Local rejections exit 2 with `invalid_arguments`: no field to change, a blank
`--name` or `--description`, `--description` with `--clear-description`,
`--auto-refresh` with `--no-auto-refresh`, a number outside the grid of the
breakpoint, `--breakpoint` without a number, `delete` without `--yes`, a
`--limit` outside 1–100 and a `--cursor` that is not a printed `nextCursor`.
Platform errors: `NOT_FOUND` (5) for an unknown dashboard, App, widget or
placement; `BAD_REQUEST` (2) for a size the widget does not support, named in
the message; `CONFLICT` (6) for a widget that is already on the dashboard or
deleting the last dashboard.

## Preferences

```sh
hatch preferences get --json
hatch preferences set --agent-message-mode queue
```

`preferences` reads and writes the caller's personal preferences. With a Run
credential they are the preferences of the user who sent the prompt the run
answers. `agentMessageMode` decides how a chat message sent while the Agent is
working is delivered: `steer` (the default) injects it into the running run
after its current tool calls finish, and several waiting messages go together;
`queue` waits until the run completes and then starts one run per message, in
send order. A change applies to messages sent afterwards.

Local rejections exit 2: `invalid_arguments` (a missing or unknown operation,
a missing `--agent-message-mode`, a value other than `queue` or `steer`, or a
positional argument). Platform errors: `CONFLICT` (6) for a Run credential
whose run has no recorded user (created before preferences, or the user was
deleted).

## Server info

```sh
hatch server info --json
```

`server info` asks the connected platform which source revision its running
server was built from and prints `commit` (the full SHA) and `commitTime`
(RFC 3339), each `null` when the build recorded none. It is the same value as
the Web Settings → About page. `hatch version` is different: it prints the
revision the CLI itself was built from and works offline.

Local rejections exit 2: `invalid_arguments` (a missing or unknown operation,
an unknown flag or a positional argument).

## Notifications

`hatch notification ...` manages the notification center with a user session,
API key or Agent Run credential. In a Run, `--group` and `--destination` sends
come from `Hatch Agent`. `hatch help notification` lists its commands and groups. `send` takes exactly one recipient. `--channel`
acts as that Channel (its id, not its token): its kinds, dedupe scope and
routes apply, and `--kind` is required. `--group` and `--destination` deliver
straight there from you, never routed, with `--kind` optional (default
`message`). `update` and `recall` take only the notification id (ids are
globally unique) and change any notification, whatever sent it:

```sh
hatch notification send --channel <channel-id> --kind build.failed --title 'master is red' --json
hatch notification send --destination <destination-id> --title 'Deploy finished' --json
hatch notification send --group <group-id> --title 'Disk 95% full' --priority high --json
hatch notification update <notification-id> --title 'master is green' --clear-body --json
hatch notification recall <notification-id> --json
```

`--priority` sets how phones present it: `high` (or `1`) is time-sensitive
and shows during Focus and Do Not Disturb, `normal` (`0`) is the default, `low`
(`-1`) arrives quietly, and `lowest` (`-2`) is never pushed to phones but stays
in history and still reaches webhooks and Apps. Write negative numbers as
`--priority=-1`; anything else, including Pushover's emergency `2`, is
rejected locally (exit 2). Priority cannot be changed later. `get` prints the
priority and `list` marks non-normal ones next to the status.

`update` changes only the flags given: `--clear-body`, `--clear-url` and
`--clear-data` clear a field, and `--auto-open-url` / `--no-auto-open-url` set
whether a phone tap opens the URL (without either, a newly added URL opens on
tap, a cleared one stops and a replaced one keeps the setting). Kind, dedupe
key and occurrence time never change. Phones replace the notification without
alerting again; webhook and App destinations that take edits and recalls
receive `hatch.notification.updated`. `recall` removes it from phones, cancels
deliveries that have not happened yet and sends `hatch.notification.recalled`
where edits and recalls are taken; it cannot be undone. Both answer
`{revision, changed}`; `changed: false` means nothing new happened and nothing
was sent. An edit with no change flag, or a blank recipient id, is rejected
locally (exit 2); an unknown notification id is not found (exit 5); editing a
recalled notification or sending to a disabled Channel or destination is a
conflict (exit 6).

### Reply forms

`send --reply <json>` (or `--reply-file <path|->`) asks for one answer; the
form is checked locally with the platform's rules and an invalid one exits 2
with the field to fix (`--reply: fields.0.options: …`). Answer it as the
signed-in user with `respond`; repeat `--answer` for each option of a
`multiple` field, or pass the whole object with `--answers`/`--answers-file`:

```sh
hatch notification send --channel <channel-id> --kind deploy --title 'Deploy v2.4?' \
  --reply '{"fields":[{"id":"decision","type":"buttons","label":"Approve?","options":[{"id":"approve","label":"Approve"},{"id":"reject","label":"Reject"}]}]}'
hatch notification respond <notification-id> --answer decision=approve --json
hatch notification list --reply-state awaiting
```

A notification takes one answer and it is final: answering again, or answering
a recalled notification, is a conflict (exit 6), and an answer that does not
fit the form is `BAD_REQUEST` (exit 2) naming the field. `get` shows the form,
the answer and its deliveries. Answers go where response routes send them:

```sh
hatch notification response-route create --source-type channel --source <channel-id> --destination <webhook-id>
```

A response route targets a webhook, or an App whose manifest sets
`notifications.destination.responses` (`destination list` marks those
`responses`). `retry` also retries failed answer deliveries.

`hatch notification delete <notification-id> --yes` permanently removes a
notification and its delivery history, whatever sent it; it cannot be undone
and answers `{}`. Without `--yes` it is rejected locally (exit 2). It sends nothing: copies already on phones, webhooks and Apps
stay, so recall first to remove it from phones. Deliveries not yet made are
dropped, and the dedupe key is free again. An unknown id is not found (exit 5).

Webhooks take edits and recalls only with `webhook create --lifecycle-events`
or `webhook update <id> --lifecycle-events` (`--no-lifecycle-events` turns it
off); `destination list` marks them `edits+recalls`.
