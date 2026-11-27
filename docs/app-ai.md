# App AI

Apps call the platform's configured models from their backend through
`@hatch/app/ai`. The provider key stays in the platform process; the App only
names a role it declares in its manifest, and the owner decides which model
serves it.

The App-side guide (manifest, SDK, error codes) is
[`skills/building-apps/references/ai.md`](../skills/building-apps/references/ai.md).
This page describes the platform contract.

## Scope

- Chat (streaming text, tool definitions and results, image input) and image
  generation.
- No Agent delegation: an App cannot start a platform Agent Run. A Run
  credential carries the user's full authority, and an App processes outside
  input (webhooks, forms), so a prompt injection would reach the whole
  platform. Apps run their own tool loops with their own functions instead.
- Backend only. The browser has no signing secret, so a frontend calls the
  App's own backend, which calls the model.

## Manifest

`capabilities.ai` must match a top-level `ai: { roles: [...] }` block, and
requires `capabilities.backend` with `backend.entry`
(`packages/hatch-manifest/src/app-schema.ts`). The normalized deployment
manifest records `ai: { url, roles }` (`src/server/apps/manifest.ts`). The
backend gets `HATCH_AI_URL` (loopback platform URL) only when the capability
is on (`src/server/apps/runtime.ts`), and the URL is added to the backend's
automatic network allow-list.

This is a new optional capability; `LATEST_APP_COMPATIBILITY_VERSION` is
unchanged.

## Runtime endpoints

`POST /api/app/<id>/ai/chat` and `POST /api/app/<id>/ai/image`
(`src/server/apps/runtime-api/ai.ts`, wire contract in
`src/server/apps/ai/contract.ts`).

Checks, in order:

1. The App exists, is not archived, has a current deployment, the `ai`
   capability and a signing secret; otherwise 404.
2. Body at most 8 MB (413), HMAC over `<timestamp>.<body>` with the App's
   signing secret (403), supported deployment (503).
3. Body schema (`ai_invalid_request`, 400).
4. The role is declared by the live deployment (`ai_role_not_declared` or
   `ai_role_kind_mismatch`, 422).
5. Model resolution (`src/server/apps/ai/models.ts`): the owner's binding
   for the role; else the default model for Apps of the role's kind
   (`apps.aiDefaults` in `platform_config`); else the first usable model of
   that kind in provider and model order. A disabled binding or default
   fails with `ai_model_unavailable` instead of falling through; none at all
   is `ai_no_model` (both 409).
6. At most four calls in flight per App and platform process (`ai_busy`,
   429).
7. The call. Chat goes through pi-ai with the same model config an Agent Run
   uses (`src/server/model-resolution.ts`, `src/agent/remote-models.ts`).
   `maxTokens` is at least 16 (OpenAI Responses APIs never go below it) and
   is capped at the model's limit; the model's default thinking
   level applies. Reasoning blocks come back as opaque `reasoning` parts
   (base64url JSON with the producing api/provider/model, the thinking text
   and its signature) that the App sends back unchanged; the platform
   restores them as thinking blocks attributed to that model, so pi-ai
   replays signatures only to it. A client disconnect, including an SDK
   caller that stops iterating, aborts the provider request. Images use the
   image drivers and are re-encoded as PNG.
8. A usage row (`app_ai_usage`): role, kind, provider name, model id, tokens,
   images, status, error code, duration. Prompts and replies are never
   stored. Billing (prices, budgets, spend) is out of scope for now.

Errors are JSON `{ ok: false, error: { code, message } }`. Streamed chat is
server-sent events: `text` (`{ delta }`), `tool_call` (`{ type, id, name,
arguments }`), then one `done` (the same body as the non-streaming JSON
result) or `error`.

## Owner settings

`src/server/apps/ai/settings.ts` serves the Web UI (Server Functions in
`src/server/app-ai.ts`: the App manage page and the "Default models for Apps"
card in Settings → AI Providers) and the public `AppService` RPCs
`GetAppAi`, `SetAppAiRoleModel`, `ListAppAiUsage`, `GetAppAiDefaults` and
`SetAppAiDefaults` (`hatch app ai show|set-model|usage|defaults`). The
defaults are stored as model ids; deleting that model clears the default, so
the first usable model applies again. Bindings live in
`app_ai_role_bindings`; deleting the bound model deletes the binding, so the
role falls back to the default. Disabling the bound model makes the role
`unavailable` until the owner picks another.
