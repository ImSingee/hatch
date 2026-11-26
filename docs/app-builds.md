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

### Who is trusted with a build

Without running the source, the platform cannot prove that a package is what
the commit builds to. Whoever produces the package is therefore trusted with
everything the package declares: a manifest is evaluated by the builder, and
its `extraPermissions` (up to `--allow-all`), RPC service and data schema
become the deployment's, within the checks above.

- A local build is made by a caller who may deploy the App anyway, with the
  same authority as every other workspace credential, so it adds no power.
- The Builder holds `HATCH_BUILDER_TOKEN`, which can claim any queued build
  and upload its package: it is equivalent to deploying any App. Run Builders
  only where you would run the platform, keep the token as secret as the
  platform's own, and never hand it to App code. A build job never receives
  the token, and the App code it runs uses the sandbox identity. Reaching the
  token therefore takes an escape from that sandbox, which before Builders
  happened in the platform process itself.

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
