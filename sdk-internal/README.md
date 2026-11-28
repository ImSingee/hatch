# Platform-managed SDKs

This directory owns SDK source, public package definitions, and generated
distribution output. These private, versionless packages are materialized by
the platform; Apps must not install them or commit `.hatch/`.

| Package       | Authored source                      | Public entrypoints                                                                                                                 |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@hatch/app`  | `app/src`                            | `.`, `./data`, `./data/react`, `./notifications`, `./storage`, `./storage/react`, `./storage/install`, `./tasks`, `./ai`, `./apps` |
| `@hatch/data` | None; generated compatibility facade | `.`, `./react`                                                                                                                     |

`@hatch/app/storage/install` is not for App source: the platform build runs
it in a classic script at the start of each App page's `<head>` and as the
banner of each widget bundle, scoping `localStorage` and `sessionStorage` to
the App id before App code runs. `@hatch/app/storage` reads that scope.

The App root exports `defineAppManifest` and `AppManifestInput`. Their input
types derive from the canonical schemas in
`packages/hatch-manifest/src`, also used by platform validation. Keep shared
contracts there; SDK-only implementation belongs here.

## Build and distribution

Run `pnpm hatch-sdk:build` to build all payloads or `pnpm hatch-sdk:check` to
check SDK source. Package `exports` and `definitions.ts` drive runtime builds,
type entrypoints, and platform resolution. Add an entry's source or re-export
target to the definition when adding a public export.

The build bundles ESM entrypoints with esbuild, sharing chunks within each
package and leaving declared peer dependencies external. It emits declarations
with the repository's TypeScript compiler and asks that compiler for each
package's declaration dependency graph. Only reachable declarations are copied
under `dist/_types`; public declarations re-export them. Public JS entrypoints
carry `@ts-self-types` for sources that build with the Deno toolchain; `tsc`
resolves the same declarations as the sibling `.d.ts` of each entrypoint. Each
payload ships only the schemas and implementations reachable from its own
entrypoints, so each remains independently resolvable.

All payloads are built and validated in staging before replacing `dist` trees.
Generated output is ignored by Git. Docker and SDK materialization consume only
each package's `package.json` and `dist`. Runtime loading does not depend on this
repository's source files. Do not replace this process with recursive copying
of another package's entire build directory.

## Generated toolchain files

Sources that build with the pnpm toolchain carry no compiler configuration.
`sdkToolchainFiles` in `definitions.ts` generates it from the same export
definitions, and both delivery paths (SDK materialization in
`src/agent/hatch-sdk.ts` and `SdkService/GetSdk`) write identical bytes into
`.hatch/`:

| File                     | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `tsconfig.json`          | Fixed compiler options and `@hatch/*` paths; whole source    |
| `tsconfig.manifest.json` | Checks only `manifest.ts`                                    |
| `tsconfig.schema.json`   | Apps only; checks only `data/schema.ts`                      |
| `types/deno.d.ts`        | `Deno` namespace declarations, from the locked `@types/deno` |
| `types/deno.LICENSE`     | License of those declarations                                |

`paths` targets have no file extension, so `tsc` selects each entrypoint's
declaration file and esbuild selects its JavaScript file. The platform, the
Runner and the CLI must check a source against the same configuration; change
it only in `sdkToolchainFiles`.

## Legacy Data imports

For currently supported App contracts, `@hatch/data` and `@hatch/data/react`
contain only JS/type re-exports of the corresponding App entrypoints. They do
not duplicate implementations or create new class identities. New source uses
`@hatch/app/data` and `@hatch/app/data/react`; existing source can migrate by
changing those module specifiers without changing schemas or application data.

Historical deployment artifacts are immutable and retain their own runtime
bytes. SDK refresh applies to source worktrees and disposable build inputs.
The proposed removal of legacy Data imports is recorded only in the App
compatibility Skill; no compatibility version is advanced by this refactor.

Platform and Runner must use the same SDK build. Complete both updates before
resuming creation/build tasks. A platform downgrade must retain the new import
entrypoints or restore migrated source imports; deployment rollback continues
using the original artifact. Public npm distribution and independent package
versioning are outside this contract.
