# App builds and deployments

The platform never runs App source. A deployment names a commit already on
the App's `master`, its build runs elsewhere, and the platform checks the
resulting build package and releases it.

```text
hatch app deploy ── git push ──▶ master
                 ── CreateAppDeployment(commit, build) ──▶ deployment (app_builds row)
   build: builder ─▶ queued ─▶ Builder leases it, downloads the commit,
                               builds, uploads the package
   build: local   ─▶ awaiting_artifact ─▶ the CLI builds the commit here and
                               uploads the package (UploadAppDeploymentArtifact)
                 ─▶ verifying (finalizeBuild) ─▶ releasing (releaseDeployment) ─▶ ready
```

Every unfinished state can end `failed`, `canceled` or `superseded`. A new
deployment supersedes older ones still `queued` or `awaiting_artifact`; a
build that finishes after a newer deployment was released is not released.
One App builds one deployment on the Builder at a time. Log lines are rows of
`app_build_logs`, so `WatchAppDeploymentLogs`, `hatch app deployments logs
--follow` and the manage page resume from any line; PostgreSQL `NOTIFY` only
wakes followers, on every platform instance.

## Where builds run

- **Dedicated Builder** (optional): `node dist/builder/main.mjs`, the same
  image as the platform, enabled by setting `HATCH_BUILDER_TOKEN` on both.
  It has no database credentials or platform secrets. It pulls work over the
  platform's internal server (`/internal/api/builds/*`,
  `src/builder/protocol.ts`), so the platform keeps no connection to it and
  may run as several instances. Each build runs in a child process that never
  receives the token; authored code runs under the sandbox identity, as it did
  on the platform. `BUILDER_CONCURRENCY` builds run at once, and several
  Builders can share the queue. A Builder that stops renewing its lease loses
  the build: it is queued again once, then fails with `builder_lost`.
- **Local**: the CLI builds a checkout of the commit with the platform's
  pinned toolchain from `GetSdk.tooling` (installed once into
  `~/.cache/hatch/toolchain`, or `HATCH_BUILD_TOOLCHAIN_DIR` when that
  directory's `node_modules` already holds those versions, as the image's
  `/app` does for the Agent's Runner). A local deployment that receives no
  package within 30 minutes fails with `artifact_timeout`.

Both run `buildAppSource` (`src/app-build/produce.ts`) and produce the same
`hatch-build-v1` package (`src/app-build/format.ts`).

## What the platform checks

`finalizeBuild` (`src/server/apps/finalize.ts`) treats a package as untrusted
input and runs none of it:

- the archive holds only regular files and directories below its root, within
  the size and count limits (`src/app-build/archive.ts`);
- the package was built for this App, deployment and commit, with this
  platform's toolchain and SDK (`toolchain_mismatch` otherwise);
- the evaluated source manifest is validated again and must name the App;
  `extraPermissions`, the RPC service, task inputs, cron schedules, the Data
  Table descriptor and docs are checked without running code, and migration
  SQL is still planned by the platform;
- `manifest.normalized.json` (which carries the backend's runtime
  permissions) and `deployment.json` are written by the platform; a package
  that contains them is refused;
- a native frontend's NSH runtime is published as its own content-addressed
  set, and its player page is the platform's (see
  [Native App runtime](app-native-runtime.md)).

What only a build can check (type checks, manifest and schema evaluation,
bundle imports, the NSH start-up check) is the builder's responsibility. The
backend's boundary at run time stays the Deno sandbox with the permissions
the platform derived. Where an artifact came from is recorded on the
deployment (`build_origin`: `builder` or `local`; null for deployments the
platform built before).

### What a build is trusted with

The manifest decides what a release may do: the backend's `extraPermissions`
(up to `--allow-all`), its network and environment grants, tasks and cron,
native capabilities. So the platform never takes it from the package. It
checks out the deployment's commit from its own repository and evaluates
`manifest.ts` itself (`evaluateAppSourceManifest`), in the same sandbox the
builds use: the sandbox identity, no network, a time limit. The package's
manifest must be exactly that one, or the deployment fails with
`app_build_invalid`. A manifest that imports only the SDK and the App's own
files, as the template and the Skill do, is evaluated without installing
anything. One that imports a package is evaluated again after the
platform installs the commit's lockfile, so that deployment pays for an
install on the platform. That install runs as the sandbox identity too, from
the frozen lockfile with every package's scripts disabled, into a pnpm store
and home of its own (never the shared store). It is capped by the usual step
time limits and at 1 GiB of installed files, and the installed tree serves
this evaluation only: it is removed with it and never shipped or reused. A
lockfile that cannot install that way fails the deployment with
`app_build_invalid`.

This brings one evaluation of authored code back into the platform, which
the move to Builders and local builds otherwise removed. That is the
trade-off for keeping the manifest's grants bound to the committed source:
without it, a compromised Builder (which holds `HATCH_BUILDER_TOKEN` and can
claim any queued build) could give any App's release any permission.

What the platform still takes from the builder, because checking it would
mean building the App, is the code: the frontend page and its scripts,
widgets, backend bundles, the RPC descriptor, the Data Table descriptor and
docs, within the checks above. This is inherent to delegating a build, as
with a compromised CI runner. A forged backend bundle does whatever it likes
within the permissions its commit's manifest grants, and no more. A forged
frontend runs with whatever reach App frontends have: today App pages are
same-origin with the platform (see the trust model in
[Native App runtime](app-native-runtime.md)), so that is the reach of the
signed-in viewer, the same reach any App code its authors deploy already
has. Giving App pages their own origin is the change that narrows both. A forged Data Table
schema can change only that App's tables, and a destructive change still
needs the approval token of its plan. Run Builders only where you would run
the platform, and keep their token as secret as the platform's own. A build
job never receives the token, and the App code it runs uses the sandbox
identity.

## Operating it

- Without `HATCH_BUILDER_TOKEN`, every deployment builds locally: `--build
  builder` fails with `BUILDER_UNAVAILABLE`, and the manage page offers no
  Redeploy.
- With it, start one or more Builders (`docker compose --profile builder up
  -d`, or `pnpm dev:builder` in development). Deployments stay `queued` while
  no Builder runs.
- The platform settles deployments nobody moves any more every 30 seconds and
  at startup: lost leases, missing uploads, and a verify or release that a
  restart interrupted (`release_interrupted`, unless the deployment was
  recorded).
