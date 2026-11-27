# AI in Apps

An App backend can call the AI models configured on the platform: chat
models (streaming text, tool calls, image input) and image models. The App
names a **role** it declares; the owner picks which model serves each role.
The provider API key never reaches the App.

Do not ask the user for an OpenAI, Anthropic or other provider key, and do
not open backend network access to a provider. Declare a role instead.

## Declare roles

Enable `capabilities.ai` (it requires `backend`) and list the roles under
`ai.roles`. A role is a job the App needs a model for, named for what it
does, not for a model:

```json
{
  "capabilities": { "backend": true, "ai": true },
  "backend": { "entry": "backend/main.ts", "runtime": "deno-serve" },
  "ai": {
    "roles": [
      {
        "name": "summarize",
        "kind": "chat",
        "description": "Summarizes a saved article into three bullet points."
      },
      {
        "name": "assistant",
        "kind": "chat",
        "description": "Answers questions about the user's tasks and edits them with tools.",
        "needs": ["tools"]
      },
      {
        "name": "cover",
        "kind": "image",
        "description": "Draws a cover image for a recipe."
      }
    ]
  }
}
```

- `name`: 1-32 lowercase letters, digits, `_` or `-`, starting with a letter;
  unique in the App.
- `kind`: `chat` or `image`.
- `description`: shown to the owner when they pick the model, so say what the
  role does and what quality it needs.
- `needs` (chat only, optional): `tools`, `vision`, `reasoning`. The owner is
  warned when the chosen model lacks one; calls are not blocked.
- At most 20 roles.

A role without an owner pick uses the platform default of its kind (the first
chat model, or the first usable image model). Never hard-code a provider or
model id in App code.

## Call a chat role

```ts
import { chat, complete, replyText } from '@hatch/app/ai';

// One JSON reply.
const result = await complete({
  role: 'summarize',
  system: 'Reply with exactly three short bullet points.',
  messages: [{ role: 'user', content: article }],
  maxTokens: 400,
});
const summary = replyText(result);

// Streamed reply, for example forwarded to the frontend over a server stream.
for await (const event of chat({ role: 'summarize', messages })) {
  if (event.type === 'text') send(event.delta);
  if (event.type === 'done') usage = event.result.usage;
}
// Or just the text: await chat({ ... }).text()
```

Messages are provider-neutral:

- `{ role: 'user', content: string | parts }`, where parts are
  `{ type: 'text', text }` and `{ type: 'image', data: <base64>, mimeType }`
  (png, jpeg, webp or gif);
- `{ role: 'assistant', content: string | parts }`, where parts are text and
  `{ type: 'toolCall', id, name, arguments }`;
- `{ role: 'tool', toolCallId, toolName, content, isError? }` for a tool
  result.

The result has `message` (the reply's text, tool calls and opaque
`{ type: 'reasoning', state }` parts), `stopReason` (`stop`, `length` or
`toolUse`), `usage` (token counts)
and `model` (`provider`, `id`). Keep the whole `message`, reasoning parts
included, in the history you send next: some providers reject a tool result
without the reasoning that asked for it. Never change, show or store a
reasoning part on its own; `replyText` skips it. A changed one fails with
`ai_invalid_request`. One request body is at most 8 MB, including inline
images.

Stop iterating `chat()` (for example `break`) to cancel a reply: the platform
aborts the provider request and records the call as aborted.

## Tools: run the loop in the App

Tools are the App's own functions; the model gets no platform authority.
`runTools` runs the loop: call the model, run each requested tool, send the
results back, repeat until a reply without tool calls or `maxSteps` (default 8) model calls.

```ts
import { replyText, runTools } from '@hatch/app/ai';

const { result, messages } = await runTools({
  role: 'assistant',
  system: 'You manage the user’s task list. Use the tools; never invent tasks.',
  messages: [{ role: 'user', content: question }],
  tools: [
    {
      name: 'list_tasks',
      description: 'List open tasks.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      run: () => db.listOpenTasks(),
    },
    {
      name: 'complete_task',
      description: 'Mark one task done.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      run: ({ id }) => db.completeTask(String(id)),
    },
  ],
});
```

Validate tool arguments in `run` like any untrusted input: the model writes
them, and user text in the conversation can steer it. A tool that throws is
sent back as an error result. Keep `messages` (for example in a Data Table)
to continue the conversation later.

## Generate an image

```ts
import { generateImage } from '@hatch/app/ai';

const image = await generateImage({ role: 'cover', prompt, quality: 'medium' });
// image.bytes is a PNG (Uint8Array); image.base64 is the same bytes.
```

`quality` is `low`, `medium` (default) or `high`. Store the bytes (for example with
Storage) instead of regenerating them.

## Errors

Every failure throws `AiError` with a stable `code` and the HTTP `status`:

| code                    | meaning                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `ai_unavailable`        | No `HATCH_AI_URL`: `capabilities.ai` or the backend is missing. |
| `ai_invalid_request`    | The body failed validation; the message names the field.        |
| `ai_role_not_declared`  | The live deployment does not declare the role.                  |
| `ai_role_kind_mismatch` | A chat role was used for an image or the reverse.               |
| `ai_no_model`           | The platform has no model of that kind configured.              |
| `ai_model_unavailable`  | The owner's chosen model is disabled.                           |
| `ai_busy`               | Four calls are already in flight for this App; retry later.     |
| `ai_provider_error`     | The provider failed or the call was cancelled.                  |

Show the user a clear message for `ai_no_model` and `ai_model_unavailable`
(the owner has to configure or change a model) instead of a generic
failure. Retry `ai_busy` and transient `ai_provider_error` with
backoff; never retry in a tight loop.

## Limits

The platform records every call (role, model, tokens, status; never prompts
or replies). A cron job or task that calls a model on every run multiplies
model usage, so batch work and cache results. An App may have at most four AI
calls in flight.

## Owner settings and the CLI

A role uses, in order: the model the owner picked for it on the App's page;
otherwise the default model for Apps of its kind (Settings → AI Providers →
Default models for Apps); otherwise the first usable model of that kind. The
App's manage page has an AI section with the model of each role and the
calls. The same settings are in the CLI:

- `hatch app ai show <app>`: roles, the model each uses and where it comes
  from, and the models a role may be set to.
- `hatch app ai set-model <app> --role <name> --model <id|provider/model>` or
  `--clear`.
- `hatch app ai defaults [--chat-model <ref> | --clear-chat-model]
  [--image-model <ref> | --clear-image-model]`: show or change the default
  models every App's unpicked roles use.
- `hatch app ai usage <app>`: calls newest first and this month's totals.

Pick a model for a role only when the user asks; otherwise leave the default.

## Local checks

`HATCH_AI_URL` and `HATCH_SIGNING_SECRET` exist only in a deployed backend.
Pass `{ url, signingSecret }` as the second argument only in tests against a
fake server; deployed code uses the defaults.
