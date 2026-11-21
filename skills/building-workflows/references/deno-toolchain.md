# Deno toolchain for Workflows

This reference applies only to a Workflow whose source root has `deno.json`
and `deno.lock` and no `pnpm-lock.yaml`. Such a Workflow installs, checks, and
bundles with Deno. Follow this file in place of the Dependencies and Local
validation sections of `building-workflows`; everything else in that Skill
applies unchanged. Never add `pnpm-lock.yaml` to such a source: files of both
toolchains together are rejected. Moving the Workflow to the pnpm toolchain is
optional and described in `workflow-compatibility`.

## Source layout

```
workflows/<slug>/
  package.json         npm dependencies (installed only with Deno)
  deno.json            reviewed npm lifecycle-script allowlist
  deno.lock            Deno dependency lock (commit this file)
```

Never add `@hatch/*` to `package.json`, `deno.json`, or `deno.lock`, or map
them in source-owned import maps. Local Deno tooling resolves `@hatch/workflow`
through the generated `.hatch/import-map.json`.

## Dependencies and lifecycle scripts

**Deno is the only package manager of a Deno-toolchain Workflow.** Never run
`npm install`, `pnpm install`, or generate npm/pnpm lock files. After every
dependency change, run this in the workflow source root:

```bash
deno install --package-json --node-modules-dir=auto --lock=deno.lock
```

Commit `package.json`, `deno.json`, and the resulting `deno.lock`; never commit
`node_modules`. `deploy_workflow` repeats the install with `--frozen`. Missing or
stale files fail deploy. If deploy reports a legacy deno.json-only source, move
every `npm:` import into `package.json`, run the command above, and commit all
three files before deploying again.

For local Deno commands that load workflow source, always select the generated
import map explicitly:

```bash
deno check --config=deno.json --node-modules-dir=auto \
  --import-map=.hatch/import-map.json --lock=deno.lock --frozen ./workflow.ts
deno test --import-map=.hatch/import-map.json
deno run --import-map=.hatch/import-map.json <local-harness.ts>
```

Run the source check before committing, replacing `./workflow.ts` with the
manifest's entry path when different. It checks that entry and its transitive
imports. `deploy_workflow` repeats this check with the committed dependencies
and a fresh platform SDK before bundling, describe-mode execution, or artifact
publication. Type errors fail deploy and must be fixed in authored source and
committed before retrying; bundling and input-schema extraction do not replace
type checking.

Deno skips npm `preinstall`, `install`, and `postinstall` scripts by default. If
it reports a skipped lifecycle script, do not enable it blindly:

1. Find the exact resolved version in `deno.lock`; inspect the package's
   lifecycle command and every local script it invokes.
2. Choose another dependency if it downloads or executes unreviewed remote
   code, reads credentials/project-external files, writes outside the package or
   project, changes global configuration, elevates privileges, is obfuscated or
   dynamic, or cannot be fully traced.
3. Reject npm native addons and generated runtime files that cannot be
   carried by the single-file Workflow bundle. FFI through `Deno.dlopen` and
   host commands/sidecars require necessary, explicitly authorized
   `extraPermissions` as described in `building-workflows`, plus separately
   available reviewed host libraries or binaries.
4. Only after confirming the exact command is safe, add the exact locked version
   to `deno.json`—never `true`, a tag, wildcard, or range:

   ```json
   { "allowScripts": ["npm:trusted-package@1.2.3"] }
   ```

5. Run Deno install again, verify the output and Workflow, then commit
   `deno.json` and `deno.lock`. Review transitive packages independently.

## Local validation

After create/checkout has prepared `.hatch/` and locked dependencies (and after
installing any dependency changes), run from the Workflow root. If the selected
source is `manifest.ts`, check it independently before the execution entry:

```bash
deno check --config=deno.json --no-remote --node-modules-dir=manual \
  --import-map=.hatch/import-map.json --lock=deno.lock --frozen ./manifest.ts
```

This checks the manifest's own import graph, which checking `workflow.ts` may
never reach. Fix failures before continuing. For `manifest.json`, skip only
this TS check and retain JSON source; platform manifest validation still
applies. Then check the manifest's declared entry (replace `workflow.ts` below
if different) and run relevant tests with the generated import map:

```bash
deno check --config=deno.json --node-modules-dir=auto \
  --import-map=.hatch/import-map.json --lock=deno.lock --frozen ./workflow.ts
deno test --import-map=.hatch/import-map.json <test paths...>
```

`deploy_workflow` repeats TS manifest checking, validates the evaluated
configuration, and checks the execution entry and its transitive imports before
bundling or describe-mode execution. A successful TypeScript check does not
replace platform validation of paths, cross-field requirements, or serializability.
