# App icons and image generation

Every App can carry one icon. Without one it shows a monogram tile. The Agent
designs icons in chat; people can also upload a file.

## How an icon is made

1. **Image model.** The instance has at most one selected image model, stored
   as the platform setting `image.model` (`{ providerId, modelId }`). It only
   names a provider row; the API key stays in `agent_providers`. Choose it
   under Settings → AI Providers or with `hatch image-model set`.
2. **Skill.** `skills/app-icon/SKILL.md` holds the versioned prompt set: how to
   offer three candidates, one per style (Glossy: a colourful 3D object;
   Glass: a milky frosted-glass object with one accent; Line: a bold white
   line drawing), each with its own subject, plus the tile palette and one
   fixed template per style. The Agent sends only a short subject phrase
   derived from the App's name and description and the tile colour's name,
   one prompt per candidate: repeating one prompt (`--count`) returns
   near-identical objects once the tile is normalised.
3. **Generation.** `hatch image generate --subject-tile <#RRGGBB>`
   (`ImageService/GenerateImages`) asks the model for one object on a
   transparent background. The platform cuts it out, scales its longer side to
   a fixed share of a 512 px tile, centres it with a soft shadow in a deep tone
   of the colour, and lays it on a vertical gradient of that colour with a top
   highlight (`src/server/images/tile.ts`). An opaque or empty result is
   rejected, so the image model must support transparent backgrounds
   (`gpt-image-2.6-flare` and `gpt-image-2.6-sunburst` both do). With
   `--glyph-tile` the model draws a white glyph on black instead; the
   platform turns luminance into opacity and lays the glyph on the same
   gradient.
4. **Choice.** Results are _candidates_: PNG files under
   `<data dir>/image-candidates/` with an unguessable id, served at
   `/api/images/candidates/<id>` to authenticated callers and deleted after one
   day. They have no database row. The Agent shows them in an `ask` question
   and the user picks one.
5. **Icon.** `hatch app icon set <app> --candidate <id>` (or `--file`) stores
   the icon.

The model draws only the object because, in side-by-side tests, models
drifted on background colour and margins when asked for a whole tile;
composing on the platform keeps a grid of Apps reading as one family, in
any mix of styles. Icons set before prompt set 3 keep their stored image
until they are redesigned. Sample output: the
[three styles](app-icons/styles.png) side by side (22, 40 and 88 px) and a
[Glossy contact sheet](app-icons/contact-sheet.png) of 14 Apps (22, 40, 60
and 88 px), both on the Desk ground and on white.

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
