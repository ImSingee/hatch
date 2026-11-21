---
name: building-workflows
description: How to design, build, and deploy a Hatch workflow end to end — a single-file Deno program defined with defineWorkflow, a zod v4 input schema, observable retried steps, npm dependencies, and manual/cron/webhook triggers. Use this whenever you create or modify a workflow.
---

# Building a Hatch workflow

A **workflow** is a co-equal sibling of an app, but for periodic/repetitive
background tasks. Unlike an app it has **no custom UI or API** — the platform
gives every workflow the same fixed UI for triggering and auditing runs. A
workflow is pure code: a single Deno program (npm packages allowed) that the
platform **bundles into one file** at deploy time and runs on each trigger.

Call `checkout_workflow` before modifying an existing workflow; the source
defaults to `workflows/<slug>/`, but the returned absolute path is authoritative.
The platform handles bundling, versioning (git + artifact), scheduling, and
serving the webhook.

## Manifest authoring

Current source may use either `manifest.ts` or `manifest.json`; keep exactly one.
New templates use TS to let Agents validate configuration with the TypeScript
toolchain. Preserve the selected format during ordinary edits and imports.
Do not migrate JSON to TS unless the user explicitly requests that conversion,
or as part of a user-requested upgrade to a released compatibility v2 or later
that requires TS. No such version exists yet; TS-only source is recorded under
`Next (proposal)` in `workflow-compatibility`, not current policy.

Read [Source manifests](../building-apps/references/manifest-source.md) for SDK
helpers, execution boundaries, and authorized format conversion. Follow Local
validation below to check TS manifests independently before execution entries.
Do not import generated files or execution modules from the manifest.

## Source layout

```
workflows/<slug>/
  manifest.ts          declares id, name, compatibilityVersion, entry, network, triggers
  workflow.ts          your workflow: defineWorkflow({ input, run })
  package.json         npm dependencies
  pnpm-lock.yaml       dependency lock (commit this file)
  .hatch/              generated platform SDK, import map + TypeScript
                       configuration — DO NOT COMMIT
```

`create_workflow` and `checkout_workflow` materialize `.hatch/` before returning.
They also add the generated paths to the repository-local Git exclude file, so
the authored tree stays clean without changing `.gitignore`. Read the exact
files before editing.

### Build toolchain

The committed lockfile selects the build toolchain before anything in the
source is evaluated:

- `pnpm-lock.yaml`, with no `deno.json` or `deno.lock`: the pnpm toolchain.
  `create_workflow` scaffolds it, and this Skill describes it.
- `deno.json` and `deno.lock`, with no `pnpm-lock.yaml`: the Deno toolchain. It
  stays fully supported for existing Workflows. For such a Workflow, read
  [Deno toolchain](references/deno-toolchain.md) and follow it in place of
  Dependencies and Local validation below.
- Files of both families together, or no lockfile at all: deploy rejects the
  source and names the files to remove.

Check which lockfile an existing Workflow has before editing it, and never mix
the two. Do not move a Workflow from one toolchain to the other unless the user
asks; `workflow-compatibility` has the procedure. The toolchain only builds the
Workflow: it runs on Deno either way and uses `Deno.*` APIs.

## The workflow program

Write `workflow.ts` against `@hatch/workflow`. Define the **input schema with
zod v4** and a `run` function. Return a JSON-serializable result.

```ts
import { defineWorkflow } from '@hatch/workflow';
import { z } from 'zod';

export default defineWorkflow({
  // Persisted as JSON Schema on deploy; drives the manual-run form and
  // validates EVERY trigger (manual, cron, webhook) before run starts.
  input: z.object({
    repo: z.string().min(1).describe('owner/name'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  run: async (ctx, input) => {
    // Wrap meaningful units of work in ctx.step so each is recorded
    // (start/finish + every retry) and visible in the run inspector.
    const data = await ctx.step(
      'fetch',
      async () => {
        const res = await fetch(`https://api.github.com/repos/${input.repo}`);
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        return res.json();
      },
      { retry: { maxAttempts: 3, backoffMs: 500 } }, // exponential (factor 2)
    );

    ctx.log(`stars: ${data.stargazers_count}`); // goes to the run log

    return { stars: data.stargazers_count, limit: input.limit };
  },
});
```

- `ctx.step(name, fn, { retry })` — retry options: `maxAttempts` (default 1, no
  retry), `backoffMs` (default 0), `factor` (default 2). A step that throws on
  every attempt fails the run.
- `ctx.log(...)` — appends to the run log.
- `ctx.runId` — the current run id.
- If you omit `input`, the workflow takes no input.

### Runtime constraints

- Runs on Deno with **env + scoped read**. Network access follows
  `manifest.network`; compatibility v1 may omit it, which runs unrestricted.
  New Workflows must always declare `network`. Authorized `extraPermissions`
  can extend these permissions (including write/run/ffi). There is no
  per-workflow database or storage yet.
- **No AI calls** during a run.
- Keep the result JSON-serializable. Do all real work inside `ctx.step` so the
  inspector is useful.
- Treat `.hatch` as reserved case-insensitively. Do **not** edit, replace,
  depend on, copy, or commit `.hatch/`; do not create variants such as
  `.HATCH`. Create/checkout refresh it, and deploy generates a fresh trusted
  copy instead of accepting SDK bytes from workflow source. Legacy source-owned
  `hatch/workflow.ts` is unsupported.
- Extra npm deps go in `package.json` `dependencies`, then use a bare import such
  as `import dayjs from 'dayjs'`. Never add `@hatch/*` to `package.json` or the
  lockfile, or map them in source-owned import maps. `tsc` and local Deno
  commands resolve `@hatch/workflow` through the generated
  `.hatch/tsconfig.json` and `.hatch/import-map.json`.
- Use `@hatch/workflow/manifest` for `defineWorkflowManifest` and its input
  type. Both public entrypoints use the declaration exports in
  `.hatch/sdk/@hatch/workflow/package.json`; do not import private generated
  files or repository implementation paths.

### Dependencies

pnpm is the Workflow package manager. Declare npm registry versions or ranges
in `package.json` and import each package by its name. From the workflow
source root, add a package with:

```bash
pnpm add --ignore-workspace --ignore-scripts <package>
```

After editing `package.json` directly, and after `create_workflow` or
`checkout_workflow` (they do not install dependencies), install from the
lockfile and refresh it:

```bash
pnpm install --ignore-workspace --ignore-scripts
```

Commit `package.json` and `pnpm-lock.yaml`; never commit `node_modules`.
`deploy_workflow` repeats the install frozen and offline from the committed
lockfile, so a missing or out-of-date lockfile fails the deploy.

Hatch owns package-manager, registry, and compiler configuration:

- `package.json` declares `"type": "module"` and may contain only `name`,
  `version`, `private`, `description`, `license`, `type`, `dependencies`,
  `devDependencies`, and `optionalDependencies`. Every other field is rejected,
  including `packageManager` (`pnpm init` adds it; remove it), `devEngines`,
  `engines`, `scripts`, `pnpm`, `workspaces`, `overrides`, and
  `peerDependencies`.
- Dependency specifiers are npm registry versions or ranges. `file:`, `link:`,
  `workspace:`, `catalog:`, git, URL, `jsr:`, and `npm:` alias specifiers,
  local paths, and `@jsr/*` packages are rejected.
- `npm:`, `jsr:`, `http:`, and `https:` import specifiers in source are not
  supported: add the package to `package.json` and import it by name.
- Do not create any of these root files: `.npmrc` in any casing,
  `package.json5`, `package.yaml`, `.pnpmfile.cjs`, `.pnpmfile.mjs`, a misnamed
  workspace file such as `pnpm-workspace.yml` or `pnpm-workspaces.yaml`,
  `tsconfig.json`, `jsconfig.json`, or `deno.jsonc`. pnpm may write a root
  `pnpm-workspace.yaml`; builds ignore it and Git ignores it, so never rely on
  it or commit it.
- The lockfile is the single-document file pnpm writes with default settings.
  Every locked package must resolve by registry integrity; tarball URLs, git
  sources, directories, patched dependencies, and overrides are not accepted.

Dependency lifecycle scripts (`preinstall`, `install`, `postinstall`) never
run. A dependency that needs one, or an npm native addon, cannot be used:
choose another dependency. FFI through `Deno.dlopen` and host
commands/sidecars require necessary, explicitly authorized `extraPermissions`
as described below, plus separately available reviewed host libraries or
binaries. A Workflow that already depends on a reviewed lifecycle script stays
on the Deno toolchain.

If `.hatch/` is missing or stale, run `create_workflow` or `checkout_workflow`
again for the same source path. Do not recreate the SDK, import map, or
TypeScript configuration yourself.

## Manifest & triggers

The source manifest (`manifest.ts` or `manifest.json`) declares the id/name, network policy, and triggers. The input
schema is NOT in the manifest — it is derived from your zod schema at deploy
time. The JSON example below can be used in `manifest.json`, or as the object
passed to `defineWorkflowManifest` in `manifest.ts`.

```json
{
  "id": "01k43s9az5t2qpy7ejf0hm6vwc",
  "name": "Star digest",
  "description": "Summarize a repo's stars",
  "compatibilityVersion": 1,
  "entry": "workflow.ts",
  "network": ["api.github.com:443"],
  "triggers": {
    "cron": [
      {
        "name": "daily",
        "schedule": "0 9 * * *",
        "input": { "repo": "denoland/deno" }
      }
    ],
    "webhook": true
  }
}
```

Every Workflow manifest must explicitly declare `compatibilityVersion`; there
is no default or legacy fallback. Preserve the existing value during ordinary
edits. Load the `workflow-compatibility` Skill and apply its version guidance
before changing the value.

Every authored Workflow must declare `network`. New Workflows start with `[]`,
which denies all networking. Supply every hostname, wildcard subdomain, IPv4
address, or bracketed IPv6 address the Workflow needs, with an optional port:

```json
{
  "network": [
    "api.example.com:443",
    "*.services.example.com",
    "192.0.2.10:8443",
    "[2001:db8::10]:443"
  ]
}
```

A hostname without a port allows all ports for that hostname. Do not include a
scheme, path, query, CIDR range, Unix socket, comma, or unbracketed IPv6
address. Hostnames do not include their subdomains unless you use the wildcard
form. Set `"network": "unrestricted"` only when arbitrary networking is
required. Compatibility v1 still accepts an omitted field and runs it
unrestricted; never omit it from new source.

Deno uses one network permission for HTTP, HTTPS, raw TCP and UDP, DNS
resolution, and TCP/UDP listeners. Workflow describe mode and real runs use the
same declaration, and Workflows receive no automatic platform destinations.
Explicit policies also run the deployed single-file bundle with ambient config,
lockfile, npm, and remote module resolution disabled.

- **Manual**: always available from the workflow page; the form is inferred from
  the input JSON Schema.
- **cron**: each job has a `name`, a standard 5-field `schedule`
  (`minute hour day-of-month month day-of-week`), and a fixed `input` object
  that must satisfy the input schema.
- **webhook**: set `"webhook": true`. On deploy the platform generates a secret
  and exposes a PUBLIC endpoint
  `/api/workflow/<id>/run?secret=<secret>`. POST a JSON body (used as the run
  input) or GET with query params. The secret may also be sent as the
  `x-hatch-secret` header.

## Extra Deno permissions

1. Declare `extraPermissions` **only when strictly necessary**. If platform
   capabilities (network, KV, Data Tables, Workflow calls, or a pure
   JS/Wasm implementation) can achieve the goal, you must not use it.
2. **Obtain explicit user authorization before writing the declaration or
   deploying.** Explain the exact flags, why each is necessary, and the risks:
   Apps, Workflows, and the platform share the same OS user; these permissions
   are equivalent to host access and can expose platform credentials and other
   Apps' data. Without explicit consent, do not write the flags into a manifest
   or deploy them. Adding, broadening, or modifying an existing declaration
   requires fresh authorization.

Each item is a complete Deno `--allow-*` argument, for example
`--allow-run=ffmpeg,git`, `--allow-ffi=/opt/lib/example.dylib`, or `--allow-all`.
Prefer narrowly scoped flags. Deno validates names and values during deployment;
newlines and NUL are rejected. Flags are merged with platform permissions: a
bare flag wins over scoped flags of the same name, scoped values are unioned,
and `--allow-all` replaces all other permission flags. `--allow-net` and
`--allow-all` override network restrictions; scoped net values extend them.
Relative paths resolve from the deployment artifact directory, not the source
checkout. Prefer absolute paths to separately available host libraries or binaries.

The top-level declaration below is an example only: both necessity and explicit
user authorization are mandatory before writing it or deploying it.

```json
{ "extraPermissions": ["--allow-run=date"] }
```

## Local validation

After create/checkout has prepared `.hatch/` and the dependencies are installed
(see Dependencies), run from the Workflow root. If the selected source is
`manifest.ts`, check it independently before the execution entry:

```bash
tsc -p .hatch/tsconfig.manifest.json
```

This checks the manifest's own import graph, which checking `workflow.ts` may
never reach. Fix failures before continuing. For `manifest.json`, skip only
this TS check and retain JSON source; platform manifest validation still
applies. Then type-check the whole Workflow:

```bash
tsc -p .hatch/tsconfig.json
```

`tsc` is the platform's compiler and `.hatch/tsconfig.json` is its only
configuration: `strict`, `noImplicitOverride`, the `Deno` namespace from
`.hatch/types/deno.d.ts`, and the `@hatch/*` SDK mappings. Workflow source
carries no compiler configuration of its own. Relative imports state their
`.ts` extension. Types for Node built-ins (`node:*` imports) need `@types/node`
in `devDependencies`; `@types/*` packages listed in the Workflow's own
`package.json` are loaded automatically.

Run tests and local harnesses on the Deno runtime, always with these three
flags plus the `--allow-*` flags the code needs:

```bash
deno test --no-lock --node-modules-dir=manual \
  --import-map=.hatch/import-map.json <test paths...>
deno run --no-lock --node-modules-dir=manual \
  --import-map=.hatch/import-map.json <local-harness.ts>
```

Never drop `--no-lock`. A `deno.lock` or `deno.json` written beside
`pnpm-lock.yaml` makes the toolchain ambiguous, and deploy fails until the file
is removed.

`deploy_workflow` repeats the install and the TS manifest check, evaluates
`manifest.ts` in a Node process that has no file, network, subprocess, or
worker access, validates the evaluated configuration, and type-checks the
execution entry and its transitive imports before bundling or describe-mode
execution. Keep `manifest.ts` a pure declaration: it may import only local
source modules, `@hatch/workflow/manifest`, and packages from `package.json`,
and must not call Node or Deno APIs. The bundle carries every dependency; an import left
unresolved, remote URLs included, fails the deploy, and Workflow code may
import Node built-ins as `node:*`. A successful TypeScript check does not
replace platform validation of paths, cross-field requirements, or
serializability. Type errors must be fixed in authored source and committed
before retrying.

## Git workflow

1. For a new workflow, confirm the name and slug in one `ask` call with two
   separate entries in `questions`: name first, slug second. Offer style-matched
   name choices and slug suggestions based on the recommended name; let the
   user choose or enter each value independently. Explain that both are
   editable later. Reuse values the user has already explicitly provided and
   ask only for missing fields; if both are provided, skip `ask`.
   The slug is the human-facing `/workflow/<slug>` segment. Use at most 64
   characters: lowercase letters, digits, and hyphens, starting with a letter
   or digit.
   Hatch generates a separate id for the manifest, Git repository, runs,
   webhook, and all technical APIs. Always pass that id to existing-Workflow
   tools, never the slug. Only then call `create_workflow`.
   Pass `pin: true` (default) to pin it to the sidebar.
2. For an existing workflow with no checkout in this conversation, inspect it
   with `list_workflows` / `get_workflow`, then call `checkout_workflow` with
   its `id` and `clone: true`. To refresh an existing checkout, call it with
   `clone: false` and the exact returned `source_path`; update mode never creates
   or replaces a path. Use a separate `clone: true` call with the same
   `source_path` and `force: true` only to permanently discard and replace it.
3. Edit files under the exact returned source path and complete Local validation.
4. `git status`, `git add ...`, `git commit -m "message"` there.
5. Call `deploy_workflow` with that `source_path` and a required `message`.
   Deploy type-checks and bundles the program, captures the input JSON Schema,
   publishes the clean commit, tags `deploy/v<version>`, records the artifact,
   and reloads the cron schedule.

Do not `git push` from this checkout: its `origin` is a local read-only
bundle, and `deploy_workflow` uploads the commit. Never create `deploy/*` tags;
the platform owns them. A failed deploy leaves the commit on platform `master`
unreleased, so fix it with a new commit on top. If
deploy says `master` advanced, call `checkout_workflow` with the same
`source_path` and `clone: false` to refresh its origin bundle, then `git fetch
origin master`, rebase, resolve, and deploy again.

## Inspect, run & roll back

- `list_workflows` shows every workflow (name, id, slug, status, live version,
  triggers).
- `get_workflow <id>` shows the network declaration, input schema, triggers,
  recent runs, and deployment history.
- `rollback_workflow` with the `id` and `version` restores that version's bundle
  and source but does not modify existing Agent worktrees. To preserve local
  work, refresh with `clone: false` and the same `source_path`, then fetch/rebase;
  to exactly replace it with rollback source, use `clone: true`, the same
  `source_path`, and `force: true`.
- Users trigger manual runs and inspect run history (steps, logs, output, errors)
  from the workflow page; you don't run workflows yourself.

## Deploy & iterate

1. New workflow → confirm name/slug → `create_workflow`. Existing →
   `checkout_workflow` and retain its returned source path.
2. Read the files, edit `workflow.ts` (input + steps) and the source manifest (`manifest.ts` or `manifest.json`)
   (network policy + triggers), keeping the zod schema authoritative.
3. Complete Local validation (manifest and entry checks), then commit with git.
4. `deploy_workflow` with that `source_path` and a `message`. On failure, read
   the build/describe output, fix the source, commit, and deploy again.
5. Tell the user what it does, how it's triggered, and where to watch runs.
