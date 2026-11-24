# App icons

Design an App icon with one of the instance's image models, let the user
choose among candidates in chat, and set the chosen one.

Prompt set version: 3.

Every App tile in Hatch is one family: a rounded square filled with a soft,
top-lit gradient of one palette colour, carrying one object, shown as small
as 22 px. The object comes in one of three styles:

| Style  | Looks like                                               | Tile flag        |
| ------ | -------------------------------------------------------- | ---------------- |
| Glossy | a colourful, softly lit 3D object in its natural colours | `--subject-tile` |
| Glass  | a milky frosted-glass object with one accent colour      | `--subject-tile` |
| Line   | a bold white line drawing, the quietest of the three     | `--glyph-tile`   |

You write the prompt for the object only. The platform sizes and centres it,
paints the gradient and the shadow, and the UI rounds the corners, so never
ask the model for a tile, a frame, rounded corners or a ground shadow.

## When to use

- The user asks for an icon or logo for an App, or to change or remove it.
- A new App has just been deployed for the first time: offer once, in one
  sentence, to design an icon. Generate only after the user agrees, because
  every image costs provider credit.

An App without an icon shows a monogram. That is a fine result; never block
other work on an icon.

## Steps

Uploading a file the user supplies (`hatch app icon set <app> --file <path>`)
and removing the icon (`hatch app icon clear <app>`) need no image model: run
those commands directly. The steps below are for designing a new icon.

1. Run `hatch image-model list --json`. If no model has `usable: true`, tell
   the user to add an image model to an OpenAI provider (Settings → AI
   Providers → Add model, then set its category to Image, or
   `hatch model add --provider <id> --model-id <id> --kind image`) and stop. Otherwise pick the model whose
   `name` and `description` best fit polished app icons, or the user's
   stated preference; with no clear fit, use `defaultModelId`. Glossy and
   Glass need transparent backgrounds, which `gpt-image-2.6-flare` and
   `gpt-image-2.6-sunburst` support. Pass the chosen `id` as `--model` to
   every generate command below so all candidates come from the same model.
2. From the App's name and description, pick three different subjects and
   give each one its own style, so the three candidates offer a real choice
   of both look and idea. Use nothing else about the App or the user in the
   prompt.
   - **Glossy**: the subject with the most characteristic colours or
     material (a flame, a wallet, a cooking pot).
   - **Glass**: any chunky subject; it is rendered white, so colour does not
     matter (a cloud, a folder, a shield).
   - **Line**: the subject with the simplest, most recognisable outline (a
     checkmark in a square, an hourglass, a gauge).

   Then pick one tile colour for all three (rules below). When the user asks
   for one style only ("only Line icons"), give all three subjects that style.

3. Write one prompt file per candidate from its style's template, then
   generate one image per file. Issue the three commands in the same turn so
   they run in parallel:

   ```sh
   hatch image generate --model <id> --prompt-file icon-glossy.txt --subject-tile '#3E63DD' --json
   hatch image generate --model <id> --prompt-file icon-glass.txt --subject-tile '#3E63DD' --json
   hatch image generate --model <id> --prompt-file icon-line.txt --glyph-tile '#3E63DD' --json
   ```

   Never use `--count` above 1 for icon candidates: the same prompt returns
   near-identical images once the platform normalises size and position.
   Each result has an `id` and a `path`. Candidates expire after one day.
   When a command fails, handle it as listed under Failures, then show
   whatever candidates succeeded; with none, tell the user why and stop.

4. Call `ask` with one question whose text shows the candidates as Markdown
   images, using each `path` exactly as returned and a letter label with the
   style name, one candidate per line:

   ```markdown
   Which icon do you prefer?

   A (Glossy) ![A](/api/images/candidates/<id-a>)

   B (Glass) ![B](/api/images/candidates/<id-b>)

   C (Line) ![C](/api/images/candidates/<id-c>)
   ```

   Offer one option per candidate ("A", "B", "C") plus "Try different
   ideas". Only these platform paths render as images; never link an external
   image.

5. Set the chosen one: `hatch app icon set <app-id> --candidate <id> --json`.
   For "Try different ideas", pick three new subjects and generate again,
   keeping one candidate per style unless the user named a style they want.
   Stop after three rounds and ask what the user has in mind.

To use a file the user provides, run
`hatch app icon set <app-id> --file <path>` (PNG, JPEG or WebP, at most 4 MB).
To remove the icon, run `hatch app icon clear <app-id>`. `hatch app icon get
<app-id>` shows the current state.

## Subject

Each candidate shows one concrete, everyday object that stands for what the
App does. The three subjects differ in outline, not three views of the same
object: for an API quota App, "a semicircular gauge dial with a needle", "a
battery with one charge bar" and "an hourglass" rather than three gauges.

- One object only. Never combine two ("a calendar with a magnifying glass",
  "a sun behind a cloud"): at 22 px the parts merge into a blob. Pick the one
  that carries the meaning. A part of the object may carry a simple mark
  ("a clipboard with a big checkmark", "a desk calendar page").
- Prefer chunky objects with a strong silhouette: a folder, a flame, a
  wallet, an hourglass, a cloud, a gauge, a pot, a piggy bank.
- Avoid objects that need fine detail to be recognised (a keyboard, a map,
  a document with lines of text, a face) and long thin ones (a pen, a
  needle, a key).
- A Line subject must read from its outline alone, with an open interior.
- No letters, digits, words, brand marks or the App's initials.
- Describe the object in under twelve words, shape first: "a semicircular
  gauge dial with a needle", not "a dashboard for monitoring API quota".

## Colour

Pass one of these to every command's tile flag, and its name to the Glossy
and Glass prompts. Glass and Line objects are white and suit any tile, so
choose the colour for the Glossy subject: the model paints it in its natural
colours, so pick a tile that contrasts with them, not one that matches the
App's topic. A yellow folder or an orange flame needs a cool tile (blue,
violet, teal), a red heart a green or blue one, a white pot any saturated
tile. Prefer a colour that differs from the user's other Apps when you know
them. The templates also tell the model to keep its colours away from the
tile; that is a safeguard, not the way to choose.

| Colour | Value     | Contrasts well with                       |
| ------ | --------- | ----------------------------------------- |
| Red    | `#E5484D` | white, blue, green objects                |
| Orange | `#E0752D` | white, blue, grey objects                 |
| Amber  | `#D08A12` | white, blue, violet objects               |
| Green  | `#2F9E68` | red, white, brown, pink objects           |
| Teal   | `#1F9AA6` | gold, orange, white, coral objects        |
| Blue   | `#3E63DD` | yellow, orange, white, red objects        |
| Violet | `#7C5CD6` | yellow, orange, gold, pink, white objects |
| Pink   | `#D6478F` | white, blue, yellow objects               |

## Prompt templates

Replace `{subject}` and `{colour}` (the colour's name from the table, in lower
case) and keep every other word.

Glossy, with `--subject-tile`:

```text
App icon subject: {subject}. One single object, centered, shown alone on a
fully transparent background. Soft 3D style like a modern macOS app icon:
smooth rounded volumes, gentle light from the top, soft shading and subtle
glossy highlights. Use at most three harmonious colours with mostly bright,
light surfaces. The icon will sit on a {colour} tile, so the object's main
colours must be clearly different from {colour}. Chunky bold silhouette that
stays recognisable at 22 pixels, no small details, no thin parts. No text,
letters or numbers, no background, no tile, no frame, no border, no ground
shadow, no reflection.
```

Glass, with `--subject-tile`:

```text
App icon subject: {subject}. One single object, centered, shown alone on a
fully transparent background. Frosted glass style like a modern operating
system icon: the object is made almost entirely of translucent milky white
glass with a soft inner glow and a bright rim light along the edges; one
accent colour tints only one small key part, and most of the object stays
white. Smooth rounded volumes. The icon will sit on a {colour} tile, so
the accent colour must be clearly different from {colour}. Chunky bold
silhouette that stays recognisable at 22 pixels, no small details, no thin
parts. No text, letters or numbers, no background, no tile, no frame, no
border, no ground shadow, no reflection.
```

Line, with `--glyph-tile`:

```text
App icon glyph: {subject}. Pure white line drawing on a pure solid black
background that fills the whole canvas. One single centered subject built
from at most three simple geometric shapes. Very thick uniform strokes with
round caps and round joins, stroke width about one tenth of the glyph's
size, open interior, no small details. Flat: no text, no letters, no
numbers, no gradients, no shading, no grey tones, no 3D, no frame, no
border, no tile, no shadow. The subject occupies about 60% of the canvas.
Bold silhouette that stays recognisable at 22 pixels.
```

Each template matches its flag: `--subject-tile` expects a transparent
background and `--glyph-tile` a white drawing on black. Mixing them up, or
asking for a coloured background or a scene, makes generation fail.

## Failures

- `CONFLICT` "No usable image model is configured", or the chosen model's
  provider is disabled or has no API key: step 1 applies; another usable
  model may be picked instead.
- `NOT_FOUND` for the image model: it was removed; run step 1 again.
- `BAD_REQUEST` naming the image provider: relay the provider's reason; do
  not retry that prompt.
- `TOO_MANY_REQUESTS`: the hourly image limit is reached; generate nothing
  more, tell the user, and still offer the candidates that succeeded.
- `BAD_REQUEST` "not a subject on a transparent background" (Glossy, Glass)
  or "not a white glyph on black" (Line): the model ignored the style.
  Generate that candidate once more with the template unchanged; if it fails
  again, drop it. This is the only failure worth retrying. When the Glossy
  and Glass candidates both fail with the transparent-background error, the
  chosen image model cannot produce transparency: pick another usable model
  (`gpt-image-2.6-flare` or `gpt-image-2.6-sunburst`) and generate again, or
  tell the user to add one.
