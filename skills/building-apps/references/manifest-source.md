# Source manifests

App source may currently use either `manifest.ts` or
`manifest.json`. The source root must contain exactly one; two files are an
error, and a broken TS manifest never falls back to JSON. New templates use TS
so Agents can validate configuration with the TypeScript toolchain.

Preserve the authored format during ordinary edits, imports, and redeployments.
Do not migrate JSON to TS unless the user explicitly requests the conversion,
or as part of a user-requested upgrade to a released compatibility version
that requires TS: App v3+. It does not exist yet: the current latest version
is App v2. The TS-only requirement is recorded under `Next (proposal)` in the
`app-compatibility` Skill and is not active.

## Authoring

```ts
import { defineAppManifest } from '@hatch/app';

export default defineAppManifest({
  id: 'my-app',
  name: 'My App',
  compatibilityVersion: 2,
  capabilities: { frontend: true },
  app: { entry: 'app/main.tsx' },
});
```

`AppManifestInput` is also exported from `@hatch/app` for `satisfies`
declarations. Helpers do not fill defaults or perform platform operations. The
platform validates values with the same Zod contracts used to derive the input
types. App version omission retains the existing v2 default.

In both formats, the top level of the manifest is strict: undeclared fields,
including misspellings, are rejected. Retired fields remain accepted and
ignored until a newer compatibility version removes them: `version` and
`userscripts`, and an empty `workflows` list. Do not add them to new source. A
non-empty `workflows` list is rejected: Workflows were removed from the
platform, so delete the field and move the work into App tasks
([tasks.md](tasks.md)).

These SDK modules are materialized under `.hatch/` and resolved by its import
map. Do not add `@hatch/*` packages to dependency files, edit generated SDK files,
or commit them. Restore a missing SDK through checkout/preparation.

## Checking and evaluation

For `manifest.ts`, after create/checkout has materialized `.hatch/` and prepared
locked dependencies, run this from the App source root before
codegen or entry checks:

```sh
tsc -p .hatch/tsconfig.manifest.json
```

A source whose lockfile is `deno.lock` uses the manifest check in its building
Skill's Deno toolchain reference instead. Fix any errors before continuing. This explicitly checks the manifest and its
imports even when no execution entry imports them. For `manifest.json`, skip
this TS-only command without converting the file; the platform still parses
and validates JSON against its manifest schema.

Then follow the building Skill for codegen and entry checks. A manifest is
needed before RPC generation: share constants through pure source modules, not
generated code or App execution entries.

The default export must be a plain JSON configuration object, not a factory or
Promise. Imports may use local source and locked pure dependencies. Evaluation
has no file, network, subprocess, worker or FFI access and sees no platform
secrets, so a manifest and the modules it imports must not call Deno or Node
APIs. Its permissions are independent of the declared backend network
policy. Imports cannot escape the source root or use remote modules. Evaluation has a
30-second timeout and a 1 MB output limit.

Omit optional properties instead of assigning `undefined`. Functions, BigInt,
non-finite numbers, class instances, custom serialization, accessors, sparse
arrays and circular values are rejected. TypeScript checking does not replace
runtime validation of paths, cross-field requirements, or serializability.

## Persistence and conversion

Commit the selected source file and its referenced modules. The platform saves
parsed source JSON and normalized deployment JSON; deployed runtimes and
artifact rollback do not execute the TS manifest again. Do not maintain a
generated root `manifest.json` alongside TS.

Only when conversion is authorized as described above, wrap the existing JSON
object with the appropriate helper, preserve the immutable id, and preserve
the compatibility version unless applying the requested version upgrade.
Remove the JSON file in the same commit, run the manifest check above, and
verify equivalent parsed configuration apart from any required version-upgrade
changes before deploying. Existing deployments and application data require
no migration for a source-format conversion.

An older platform may understand the deployment compatibility version but lack
the TS loader. Upgrade it before importing/rebuilding TS source. If JSON source
is required, materialize the evaluated source object using the updated platform's
restricted loader, replace TS with JSON, and verify equivalence. Never execute
unreviewed imported TS in the platform process or use unrestricted shell eval
as a conversion shortcut. Exported source archives preserve their authored format.
