---
name: model-catalog
description: Maintain Hatch's built-in model catalog (provider presets and model metadata from aidy-models), its bundled snapshot, curation and background refresh. Use when changing the catalog, adding a provider preset or recommended model, reviewing a catalog sync PR, or debugging model metadata, thinking levels or catalog updates.
---

# Model catalog

The catalog lists the providers the "Add provider" gallery offers and the
models each one serves, with the metadata a run needs: context window, max
output, reasoning, thinking levels, request compat flags and prices.

## Where things live

- `src/server/model-catalog/build.ts`: turns aidy-models' `models.json` into
  the catalog. The sync script and the platform's background refresh both
  use it, so their filters never drift apart.
- `src/server/model-catalog/curation.ts`: the provider allow-list, base URL
  or API type corrections, and each provider's recommended models.
  aidy-models has no notion of "recommended", so Hatch owns it.
- `src/server/model-catalog/catalog.json`: the bundled snapshot, generated.
  Never edit it by hand.
- `src/server/model-catalog/refresh.ts`: the background refresh. It checks
  every 6 hours with an ETag, builds and validates, stores the result in
  `model_catalog_snapshots`, and uses whichever data is newer, downloaded
  or bundled.
- `src/server/model-spec.ts`: resolves one configured model. Each field
  comes from the row's override, then the catalog entry, then a fallback.
  Thinking-level maps and compat flags prefer pi's built-in metadata for
  the same model, because pi's API drivers consume them.

## Rules

- Only the three API types Hatch runs (`anthropic-messages`,
  `openai-responses`, `openai-completions`) are kept. Chat models must call
  tools and must not be deprecated.
- Image models are offered only for providers marked `images` in
  curation, where an image driver is verified.
- The catalog fills in values but never changes a saved provider's base URL
  or API type. Data from the network is untrusted: links must be https, and
  only compat flags pi defines for the API type are kept.

## Common tasks

- **Refresh the bundled snapshot:** run `pnpm catalog:sync`, or
  `pnpm catalog:sync --ref <commit>`. In the PR, review the printed
  added/removed list, and check every compat or base URL change.
- **Add a provider preset:** add an entry to `CURATED_PROVIDERS`, with at
  least one recommended chat model, then sync. Add its avatar to
  `src/components/providers/provider-avatar.tsx`. Import the icon
  individually from `@lobehub/icons`; `ProviderIcon` would pull in every
  icon.
- **A recommended model disappeared upstream:** sync prints a warning and
  drops it. Pick a replacement in curation.
- **Tests:** `src/server/model-catalog/*.test.ts` cover the snapshot
  contract, the build filters and the refresh outcomes.
  `src/server/provider-service.test.ts` covers overrides, defaults and
  thinking levels.
