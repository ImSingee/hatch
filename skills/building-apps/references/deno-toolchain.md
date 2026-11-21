# Deno toolchain for Apps

This reference applies only to an App whose source root has `deno.json` and
`deno.lock` and no `pnpm-lock.yaml`. Such an App installs, checks, and bundles
with Deno. Follow this file in place of the dependency-file rules in Source
contract and the Dependencies and Local validation sections of `building-apps`;
everything else in that Skill applies unchanged. Never add `pnpm-lock.yaml` to
such a source: files of both toolchains together are rejected. Moving the App
to the pnpm toolchain is optional and described in `app-compatibility`.

## Source contract

The dependency and configuration files are:

```text
package.json           npm dependencies resolved by Deno
deno.json              compiler and lifecycle-script deny policy
deno.lock              committed dependency lock
```

Do not create a root `.npmrc` in any casing; Hatch owns App registry
configuration. Use only the canonical root `deno.json`; do not create
`deno.jsonc`, `tsconfig.json`, or `jsconfig.json`.

Keep the App module and compiler contract fixed: `package.json` declares
`"type": "module"`; `deno.json` sets `compilerOptions.strict` to `true`,
`compilerOptions.jsx` to `"react-jsx"`, and `compilerOptions.jsxImportSource`
to `"react"`. Do not add `imports`, `scopes`, `importMap`, or `workspace` to
`deno.json`. Use explicit relative imports and registry dependencies from
`package.json` instead.

Never exclude `.hatch/` or any of its files in the top-level `deno.json`
`exclude` array, including via glob patterns. Such exclusions can skip the
platform-generated Fetch backend contract check even when its file is explicitly
passed to `deno check`.

Do not add `@hatch/*` packages to `package.json` or `deno.lock`. Do not enable
unstable Deno import resolution.

## Dependencies

Deno is the only package manager of a Deno-toolchain App. Add normal semver
dependencies to `package.json`; never run npm or pnpm.

Apps deploy as standalone source trees. Do not use package/deno workspaces or
`file:`, `link:`, `workspace:`, absolute-path, or parent-directory dependencies;
publish or select a registry package version instead.
Use registry npm dependencies declared in `package.json`; do not import
`http:`, `https:`, or `jsr:` modules from App source.

After every dependency change, run from the App root:

```bash
deno install --package-json --node-modules-dir=auto --lock=deno.lock
```

Commit `package.json`, `deno.json`, and `deno.lock`. Deploy repeats installation
with `--frozen` and rejects stale dependency state.

Deno skips npm lifecycle scripts by default. App preparation and deploy do not
execute package `preinstall`, `install`, or `postinstall` code, even when a
package version has been audited. Keep `deno.json` `allowScripts` empty. If a
dependency needs a lifecycle script or npm native addon, replace it with a
compatible dependency: bundle-v1 bundles dependencies, so npm native addons
remain unsupported. `Deno.dlopen` can load a separately supplied library with
an authorized `--allow-ffi` declaration. Host commands or sidecars require an
authorized `--allow-run` declaration; supply reviewed binaries as backend
assets or use existing host installations, never an npm lifecycle download.

## Local validation

After create/checkout has prepared `.hatch/` and locked dependencies (and after
installing any dependency changes), run from the App root. If the selected
source is `manifest.ts`, type-check it separately before RPC codegen and entry
checks:

```bash
deno check --config=deno.json --no-remote --node-modules-dir=manual \
  --import-map=.hatch/import-map.json --lock=deno.lock --frozen ./manifest.ts
```

This checks the manifest's own import graph, which entry checks may never
reach. Fix failures before continuing. For `manifest.json`, skip only this TS
check and retain JSON source; platform manifest validation still applies.

Create and checkout already generate RPC code. After changing a proto, regenerate
it from the App root with Hatch's platform-owned template. Do not run bare
`buf generate`: that reads the App-authored `buf.gen.yaml` instead.

```bash
buf generate --template .hatch/buf.gen.yaml
```

Then type-check every enabled entry from the source manifest (`manifest.ts` or
`manifest.json`), plus `data/schema.ts` when Data Tables are enabled:

```bash
deno check --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen \
  app/main.tsx backend/main.ts widgets/counter.tsx data/schema.ts
```

Adjust the final entry list to the manifest and omit disabled or absent entries.
Run relevant tests after the check. Do not use a different import map for local
checks.

Other Deno commands that resolve App execution entries must use the same SDK,
automatic node-modules, and frozen-lock contract as the entry check. The
manifest check above uses manual node-modules to match the restricted loader.
Include authorized `backend.extraPermissions` in local execution and test
commands, using the merge rules in `building-apps` rather than appending
conflicting flags. For example:

```bash
deno test --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <merged platform and authorized extraPermissions flags...> <test paths...>
deno run --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <merged platform and authorized extraPermissions flags...> <entry.ts>
deno cache --config=deno.json --no-remote --node-modules-dir=auto \
  --import-map=.hatch/import-map.json \
  --lock=deno.lock --frozen <entries...>
```

`deploy_app` performs the same source check before schema evaluation, production
bundling, database migration, artifact persistence, or live-release activation.
Its later bundle check verifies the emitted artifact and does not replace the
source check. A failed source check must be fixed in authored source and
committed before retrying deploy.
