---
name: app-icon
description: Design an App icon with the instance image model, let the user choose among candidates in chat, and set the chosen one. Use when the user asks for an App icon or logo, wants to change or remove one, or right after the first successful deployment of a new App.
---

# Design an App icon

Prompt set version: 1.

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

1. Run `hatch image-model get --json`. If `selected` is null or
   `selected.usable` is false, tell the user to choose an image model under
   Settings → AI Providers (or with `hatch image-model set`) and stop.
2. Pick the subject and the colour (rules below) from the App's name and
   description. Use nothing else about the App or the user in the prompt.
3. Write the prompt from the template to a file and generate three candidates:

   ```sh
   hatch image generate --prompt-file icon-prompt.txt --count 3 \
     --glyph-tile '#3E63DD' --json
   ```

   Each candidate has an `id` and a `path`. Candidates expire after one day.

4. Call `ask` with one question whose text shows the candidates as Markdown
   images, using each `path` exactly as returned and a letter label:

   ```markdown
   Which icon do you prefer?

   A ![A](/api/images/candidates/<id-a>) B ![B](/api/images/candidates/<id-b>) C ![C](/api/images/candidates/<id-c>)
   ```

   Offer one option per candidate ("A", "B", "C") plus "Try a different
   idea". Only these platform paths render as images; never link an external
   image.

5. Set the chosen one: `hatch app icon set <app-id> --candidate <id> --json`.
   For "Try a different idea", change the subject (not the style rules) and
   generate again. Stop after three rounds and ask what the user has in mind.

To use a file the user provides, run
`hatch app icon set <app-id> --file <path>` (PNG, JPEG or WebP, at most 4 MB).
To remove the icon, run `hatch app icon clear <app-id>`. `hatch app icon get
<app-id>` shows the current state.

## Subject

Choose one concrete, everyday object that stands for what the App does.

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

- `CONFLICT` "No image model is configured": step 1 applies.
- `BAD_REQUEST` naming the image provider: relay the provider's reason; do
  not retry the same prompt.
- `TOO_MANY_REQUESTS`: the hourly image limit is reached; tell the user and
  stop.
- `BAD_REQUEST` "not a white glyph on black": the model ignored the style;
  generate once more with the template unchanged.
