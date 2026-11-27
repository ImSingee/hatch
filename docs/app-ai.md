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
5. Model resolution (`src/server/apps/ai/models.ts`): the owner's binding, or
   the default of the role's kind (the first chat model of the Agent catalog,
   or the default image model). `ai_no_model` / `ai_model_unavailable`, 409.
6. Monthly budget (`ai_budget_exceeded`, 402) and at most four calls in flight
   per App and platform process (`ai_busy`, 429).
7. The call. Chat goes through pi-ai with the same model config an Agent Run
   uses (`src/server/model-resolution.ts`, `src/agent/remote-models.ts`).
   `maxTokens` is capped at the model's limit; the model's default thinking
   level applies; reasoning text is not returned. A client disconnect aborts
   the provider request. Images use the image drivers and are re-encoded as
   PNG.
8. A usage row (`app_ai_usage`): role, kind, provider name, model id, tokens,
   images, estimated cost, status, error code, duration. Prompts and replies
   are never stored.

Errors are JSON `{ ok: false, error: { code, message } }`. Streamed chat is
server-sent events: `text` (`{ delta }`), `tool_call` (`{ type, id, name,
arguments }`), then one `done` (the same body as the non-streaming JSON
result) or `error`.

## Cost

Cost is estimated from the catalog price of the chat model
(`usage.cost.total` from pi-ai). Image models have no price; their calls are
recorded as unpriced and count as zero towards the budget. The budget is per
UTC calendar month (`apps.ai_monthly_budget_micros`, millionths of a US
dollar); calls already in flight when the cap is reached may finish past it.

## Owner settings

`src/server/apps/ai/settings.ts` serves both the App manage page (Server
Functions in `src/server/app-ai.ts`) and the public `AppService` RPCs
`GetAppAi`, `SetAppAiRoleModel`, `SetAppAiBudget` and `ListAppAiUsage`
(`hatch app ai show|set-model|budget|usage`). Bindings live in
`app_ai_role_bindings`; deleting the bound model deletes the binding, so the
role falls back to the default. Disabling the bound model makes the role
`unavailable` until the owner picks another.
