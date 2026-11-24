---
name: app-icon
description: Design an App icon with one of the instance's image models, let the user choose among candidates in chat, and set the chosen one. Use when the user asks for an App icon or logo, wants to change or remove one, or right after the first successful deployment of a new App.
---

# Design an App icon

Prompt set version: 2.

Every App tile in Hatch is one family: a rounded square with one solid colour
and one simple white line glyph, shown as small as 22 px. You write the prompt
for the glyph only. The platform lays the glyph on the colour with fixed
margins and the UI rounds the corners, so never ask the model for a
background colour, a tile, a frame or rounded corners.

## When to use

- The user asks for an icon or logo for an App, or to change or remove it.
- A new App has just been deployed for the first time: offer once, in one
  sentence, to design an icon. Generate only after the user agrees, because
  every image costs provider credit.

An App without an icon shows a monogram. That is a fine result; never block
other work on an icon.

## Workflow

Uploading a file the user supplies (`hatch app icon set <app> --file <path>`)
and removing the icon (`hatch app icon clear <app>`) need no image model: run
those commands directly. The steps below are for designing a new icon.

1. Run `hatch image-model list --json`. If no model has `usable: true`, tell
   the user to add an image model to an OpenAI provider under Settings → AI
   Providers (category Image) and stop. Otherwise pick the model whose
   `name` and `description` best fit a crisp, simple line glyph, or the user's
   stated preference; with no clear fit, use `defaultModelId`. Pass the
   chosen `id` as `--model` to every generate command below so all
   candidates come from the same model.
2. Pick three different subjects and one colour (rules below) from the App's
   name and description. Use nothing else about the App or the user in the
   prompt. The candidates exist to offer a real choice, so each one needs its
   own subject: the same prompt run several times returns near-identical
   glyphs, because the style rules leave little room and the platform
   normalises size, position and colour.
3. Write one prompt file per subject from the template, then generate one
   image per file. Issue the three commands in the same turn so they run in
   parallel:

   ```sh
   hatch image generate --model <id> --prompt-file icon-a.txt --glyph-tile '#3E63DD' --json
   hatch image generate --model <id> --prompt-file icon-b.txt --glyph-tile '#3E63DD' --json
   hatch image generate --model <id> --prompt-file icon-c.txt --glyph-tile '#3E63DD' --json
   ```

   Never use `--count` above 1 for icon candidates. Each result has an `id`
   and a `path`. Candidates expire after one day. When a command fails,
   handle it as listed under Failures, then show whatever candidates
   succeeded; with none, tell the user why and stop.

4. Call `ask` with one question whose text shows the candidates as Markdown
   images, using each `path` exactly as returned and a letter label:

   ```markdown
   Which icon do you prefer?

   A ![A](/api/images/candidates/<id-a>) B ![B](/api/images/candidates/<id-b>) C ![C](/api/images/candidates/<id-c>)
   ```

   Offer one option per candidate ("A", "B", "C") plus "Try different
   ideas". Only these platform paths render as images; never link an external
   image.

5. Set the chosen one: `hatch app icon set <app-id> --candidate <id> --json`.
   For "Try different ideas", pick three new subjects (not new style rules)
   and generate again. Stop after three rounds and ask what the user has in mind.

To use a file the user provides, run
`hatch app icon set <app-id> --file <path>` (PNG, JPEG or WebP, at most 4 MB).
To remove the icon, run `hatch app icon clear <app-id>`. `hatch app icon get
<app-id>` shows the current state.

## Subject

Each candidate shows one concrete, everyday object that stands for what the
App does. Choose three objects that differ in outline, not three views of the
same object: for an API quota App, "a semicircular gauge dial with a needle",
"a battery with one charge bar" and "an hourglass" rather than three gauges.

- One object only. Never combine two ("a calendar with a magnifying glass",
  "a sun behind a cloud"): at 22 px the parts merge into a blob. Pick the one
  that carries the meaning.
- Prefer objects with a strong outline and an open interior: a folder, a
  flame, a wallet, an hourglass, a pencil, a gauge, a checkmark in a square.
- Avoid objects that need inner detail to be recognised (a keyboard, a map,
  a document with lines of text, a face).
- No letters, digits, words, brand marks or the App's initials.
- Describe the object in under twelve words, shape first: "a semicircular
  gauge dial with a needle", not "a dashboard for monitoring API quota".

## Colour

Pass exactly one of these to `--glyph-tile`. Prefer a colour that suits the
subject and differs from the user's other Apps when you know them.

| Colour | Value     | Typical use                    |
| ------ | --------- | ------------------------------ |
| Red    | `#E5484D` | tasks, alerts, habits          |
| Orange | `#E0752D` | feeds, cooking, energy         |
| Amber  | `#D08A12` | files, notes                   |
| Green  | `#2F9E68` | money, health, uptime          |
| Teal   | `#1F9AA6` | records, attendance            |
| Blue   | `#3E63DD` | meters, weather, general tools |
| Violet | `#7C5CD6` | learning, time                 |
| Pink   | `#D6478F` | calendars, people              |

## Prompt template

Replace `{subject}` and keep every other word:

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

The white-on-black drawing is what `--glyph-tile` expects; a prompt that
asks for colour or a light background makes generation fail.

## Failures

- `CONFLICT` "No usable image model is configured", or the chosen model's
  provider is disabled or has no API key: step 1 applies; another usable
  model may be picked instead.
- `NOT_FOUND` for the image model: it was removed; run step 1 again.
- `BAD_REQUEST` naming the image provider: relay the provider's reason; do
  not retry that prompt.
- `TOO_MANY_REQUESTS`: the hourly image limit is reached; generate nothing
  more, tell the user, and still offer the candidates that succeeded.
- `BAD_REQUEST` "not a white glyph on black": the model ignored the style.
  Generate that subject once more with the template unchanged; if it fails
  again, drop it. This is the only failure worth retrying.
