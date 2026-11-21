# Deno-toolchain fixtures

Frozen dependency files of a source that builds with the Deno toolchain
(`deno.json` + `deno.lock`): the files the default templates shipped before
they moved to `package.json` + `pnpm-lock.yaml`.

Tests copy them to prove that an existing Deno-toolchain App or Workflow still
builds, prepares and deploys with no file changes. Do not regenerate them with
the templates; they change only when the Deno pipeline itself changes.
