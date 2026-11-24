# App icons and image generation

Every App can carry one icon. Without one it shows a monogram tile. The Agent
designs icons in chat; people can also upload a file.

## How an icon is made

1. **Image models.** An image model is a provider model (`agent_models`) of
   kind `image`, chosen when the model is created under Settings → AI
   Providers or with `hatch image-model add`; the kind never changes, so
   chat and image models stay apart (the Agent model picker, catalog and run
   start only accept `chat`). Only providers whose API has an image driver
   (OpenAI Responses or Completions) can hold one, and such a provider cannot
   switch to an API type without one while it does. The instance may have
   several, each with an optional description of what it is good at. Each
   generation names one by id (`--model`); without one it uses the default,
   the first usable model in provider and model order. The API key stays on
   the provider. Migration `20261124092607_agent_model_kind` turned the old
   single `image.model` setting into an image model of its provider and
   deleted the setting.
2. **Skill.** `skills/app-icon/SKILL.md` holds the versioned prompt set: how to
   pick three distinct subjects, the tile palette and the fixed style
   template. The Agent sends only a short subject phrase derived from the
   App's name and description, one prompt per candidate: repeating one prompt
   (`--count`) returns near-identical glyphs once the tile is normalised.
3. **Generation.** `hatch image generate` (`ImageService/GenerateImages`) asks
   the model for a white glyph on black. With `--glyph-tile <#RRGGBB>` the
   platform turns luminance into opacity, scales the glyph to a fixed share of
   a 512 px tile and lays it on that exact colour (`src/server/images/tile.ts`).
4. **Choice.** Results are _candidates_: PNG files under
   `<data dir>/image-candidates/` with an unguessable id, served at
   `/api/images/candidates/<id>` to authenticated callers and deleted after one
   day. They have no database row. The Agent shows them in an `ask` question
   and the user picks one.
5. **Icon.** `hatch app icon set <app> --candidate <id>` (or `--file`) stores
   the icon.

The model draws only the glyph because, in side-by-side tests, models drifted
on background colour and margins when asked for a whole tile; composing on
the platform keeps a grid of Apps reading as one family. Sample output:
[contact sheet](app-icons/contact-sheet.png) (22, 40, 60 and 88 px on the
Desk ground and on white).

## Storage and delivery

- `apps.icon` holds the key of the current icon files, or null. Nothing else
  about an icon is persisted.
- Files live in `<data dir>/app-icons/<app id>/<key>-{64,128,256}.png`.
  Replacing or clearing an icon deletes the previous files; deleting the App
  deletes the directory.
- Input is never stored or served as-is. Accepted: PNG, JPEG or WebP by
  signature, at most 4 MB, sides 64 to 4096 px. It is decoded, cropped to a
  centred square and re-encoded as PNG without metadata. SVG is rejected.
- `GET /api/app/<id>/icon?v=<key>&size=64|128|256` accepts any platform
  credential (session, API key, Run). A URL naming the current key is
  `immutable`; any other must revalidate. The stored image is square; clients
  round the corners.
- `Resource.icon_path` in the public API carries that path for Apps that have
  an icon, so native clients can adopt it.

## Limits

- One request generates at most 4 images at 1024 px, with a 120 s timeout.
- The instance generates at most 30 images per hour (in-process counter).
- Prompts are at most 4000 characters. Only the prompt reaches the provider.

## Adding a provider

Implement `ImageDriver` in `src/server/images/drivers.ts` and register it for
the provider's `apiType`. Callers resolve the configured model and never
address a provider directly.
