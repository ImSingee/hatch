# Card markup reference

`hatch notification card catalog --json` prints the same catalog offline;
`hatch notification card check (<markup|json> | --file <path|->)` checks a
card against it.

## Syntax

- One root element, `<Card>`, holding blocks. Comments (`<!-- … -->`) are
  allowed. Names are case-sensitive: components are capitalized (`Title`),
  inline marks lowercase (`b`, `a`).
- Quote every attribute value (`tone="danger"`). A flag may be bare
  (`mono`) or `"true"` / `"false"`. An empty value counts as left out. An
  attribute a component does not have is an error.
- Write `&amp;` for `&`, `&lt;` for `<`, `&quot;` for `"` inside a
  `"`-quoted value. Only `&amp; &lt; &gt; &quot; &apos;` and numeric
  references (`&#169;`) exist. No DOCTYPE, entity definitions or `<?xml?>`.
- `<![CDATA[ … ]]>` saves escaping; whitespace rules still apply to it.
- Number lists are comma-separated (`values="210,180,260"`). Times are
  ISO-8601 (`2026-11-25T02:14:00Z`) and show in the reader's time zone.

## Whitespace

- In text and inline content, every run of spaces and line breaks becomes
  one space, trimmed at the start and end of the block. Write `<br/>` for a
  line break.
- Between blocks, whitespace is ignored; other loose text is an error: wrap
  it in `<Text>`.
- `<Code>` and `<Markdown>` keep text as written and are dedented: start the
  text on the line after the opening tag, and the indentation shared by its
  lines is removed. Text that starts right after `<Code>` keeps the next
  lines' indentation as written.
- `<Markdown>` inside a card takes Markdown source (headings, emphasis,
  lists, quotes, code, links, tables); input components cannot go in it.

## Limits

- At most 16 KiB of markup, 200 elements (a `<Markdown>` block's compiled
  elements count), 8 levels of nesting below `<Card>`, and 4000 characters
  of text per element unless the catalog says less.
- Inputs: at most 10 `Choice`, `Buttons` and `Input` in one card, with
  unique ids; 1–4 buttons per `Buttons` (labels ≤32); 2–50 options per
  `Choice`; one `Submit`; `min` and `max` only with `multiple`; one
  `default` option for a single choice.

## Tokens

- Tones: `neutral` (default), `info`, `success`, `warning`, `danger`,
  `working` (in progress). Text and captions may also be `dimmed`.
- Spacings: `xs`, `sm`, `md`, `lg`, `xl`.
- Icon names: `agent`, `app`, `pr`, `deploy`, `task`, `alert`, `shield`,
  `chart`, `clock`, `database`, `bug`, `message`, `package`, `money`.
- Step states: `done`, `failed`, `running`, `pending` (default), `skipped`.
- Field ids (`Choice`, `Buttons`, `Input`): a lowercase letter, then at most
  39 lowercase letters, digits or `_`. Option ids (`Option`, `Button`): 1–40
  lowercase letters, digits, `_`, `-` or `.`.

## Inputs

The card's `Choice`, `Buttons` and `Input` compile, in document order, into
the notification's reply form; answers come back by that order.

- `Choice` is a single choice, or several with `multiple`; optional unless
  `required`. Each `Option`'s text is its label; `note`, `badge` and
  `default` add a note, a tag and a preselection.
- `Buttons` holds 1–4 `Button id=…`; clicking one answers. Always required.
  When the card's last input is a `Buttons`, its buttons also submit the
  other inputs.
- `Input` is a text answer; optional unless `required`.
- `Submit` labels the submit button; left out, the platform adds one when
  needed.
- `Button href=…` outside `Buttons` is a link button and never answers.
- `then-status` / `then-tone` on an `Option` or answer `Button` replace the
  card's status after it is chosen (and hide the flag) until the next
  update.
- A card with inputs cannot also carry `--reply`.

## Catalog

Content: **blocks** holds components only; **inline** holds text and inline
marks; **flow** holds either; **text** holds plain text only; **raw text**
keeps text as written; **none** holds nothing; a list of names allows only
those. "In" says where a component may go.

### Roots

- `Card`: The card itself. Status, flag and icon are drawn by the platform in fixed places. In: the root. Content: blocks.
  - `icon`: an icon name. Shown in place of the source tile.
  - `status`: text ≤24. Short state shown as a pill, such as "CI failed".
  - `tone`: a tone, default `neutral`. Tone of the status.
  - `flag`: text ≤16. Urgent marker beside the status, such as "Urgent".

### Layout

- `Column`: Children stacked vertically. In: blocks. Content: blocks.
  - `gap`: a spacing. Space between children.
  - `align`: `start` | `center` | `end` | `stretch`. Alignment.

- `Row`: Children side by side; stacks on narrow screens when it holds buttons. In: blocks. Content: blocks.
  - `gap`: a spacing. Space between children.
  - `justify`: `start` | `center` | `end` | `between`. Alignment.
  - `align`: `start` | `center` | `end` | `baseline` | `stretch`. Alignment.
  - `wrap`: flag. Wrap children onto more lines.

- `Grid`: Equal columns. In: blocks. Content: blocks.
  - `columns`: integer 2–4, default `2`. Number of columns, 2-4.
  - `gap`: a spacing. Space between children.

- `Box`: A group on a tinted surface. In: blocks. Content: blocks.
  - `surface`: `muted` | `outline`, default `muted`. Muted fill or an outline.
  - `padding`: `sm` | `md` | `lg`. Inner spacing.
  - `tone`: a tone, default `neutral`. Tints the surface.

- `Divider`: A hairline between sections. In: blocks. Content: none.

- `Spacer`: Extra vertical space. In: blocks. Content: none.
  - `size`: a spacing, default `md`. How much space.

- `Collapse`: Content hidden behind a toggle until opened. In: blocks. Content: blocks.
  - `summary` (required): text ≤100. The toggle label, such as "Show 12 log lines".

### Text

- `Title`: A heading. In: blocks. Content: inline, ≤300 chars.
  - `size`: `sm` | `md` | `lg` | `xl`, default `md`. Heading size.
  - `align`: `start` | `center` | `end`. Alignment.
  - `lines`: integer 1–10. Clamp to this many lines.

- `Text`: A paragraph. In: blocks. Content: inline, ≤4000 chars.
  - `size`: a spacing, default `md`. Text size, xs-xl.
  - `weight`: `regular` | `medium` | `bold`, default `regular`. Text weight.
  - `tone`: `dimmed` or a tone, default `neutral`. Ink colour: dimmed or a tone.
  - `align`: `start` | `center` | `end`. Alignment.
  - `mono`: flag. Monospaced, for identifiers.
  - `lines`: integer 1–10. Clamp to this many lines.

- `Caption`: Small dimmed text, such as "Updated 10:52". In: blocks. Content: inline, ≤4000 chars.
  - `tone`: `dimmed` or a tone, default `dimmed`. Ink colour.
  - `align`: `start` | `center` | `end`. Alignment.
  - `lines`: integer 1–10. Clamp to this many lines.

- `Markdown`: Markdown inside a card: headings, emphasis, lists, quotes, code, links and tables. In: blocks. Content: Markdown source, compiled to blocks (each ≤4000 chars of text).

### Inline marks

- `b`: Bold. In: inline content. Content: inline, ≤4000 chars.

- `i`: Italic. In: inline content. Content: inline, ≤4000 chars.

- `s`: Struck through. In: inline content. Content: inline, ≤4000 chars.

- `code`: Inline code. In: inline content. Content: text, ≤4000 chars.

- `a`: A link; opened only when tapped. In: inline content. Content: inline, ≤4000 chars.
  - `href` (required): link. http(s), another app or a hatch:// page.

- `time`: A time shown in the reader's language and time zone. In: inline content. Content: none.
  - `datetime` (required): ISO-8601 time. ISO-8601 time.
  - `format`: `datetime` | `date` | `time`, default `datetime`. What to show.

- `br`: A line break. In: inline content. Content: none.

### Markers

- `Badge`: A small tinted label. In: blocks or inline content. Content: text, ≤40 chars.
  - `tone`: a tone, default `neutral`. Badge tone.

- `Icon`: An icon from the fixed set. In: blocks or inline content. Content: none.
  - `name` (required): an icon name. Icon name.
  - `tone`: a tone, default `neutral`. Icon tone.

### Data

- `Progress`: A bar filled to percent. In: blocks. Content: none.
  - `label`: text ≤100. What is measured.
  - `value`: text ≤40. Such as "3 / 14".
  - `percent` (required): number 0–100. 0-100.
  - `tone`: a tone, default `neutral`. Bar tone.

- `Stat`: One figure with its label. In: blocks. Content: none.
  - `value` (required): text ≤40. The figure.
  - `label` (required): text ≤60. What it counts.
  - `delta`: text ≤24. Change, such as "+62%".
  - `tone`: a tone, default `neutral`. Tone of the delta.

- `Fields`: Label and value pairs. In: blocks. Content: `Field`.
  - `mono`: flag. Monospaced values.

- `Field`: One label and its value. In: `Fields` only. Content: inline, ≤500 chars.
  - `label` (required): text ≤60. The label.
  - `mono`: flag. Monospaced value.

- `Steps`: A checklist of steps or checks. In: blocks. Content: `Step`.
  - `mono`: flag. Monospaced names in an outlined list, for checks.

- `Step`: One step. In: `Steps` only. Content: inline, ≤300 chars.
  - `state`: `done` | `failed` | `running` | `pending` | `skipped`, default `pending`. done, failed, running, pending or skipped.
  - `detail`: text ≤60. Shown at the end, such as "2m 14s".
  - `at`: ISO-8601 time. When it happened; shown as a time.
  - `href`: link. Opens the step, such as its log.

- `List`: A bulleted, numbered or task list. In: blocks. Content: `Item`.
  - `ordered`: flag. Numbered.

- `Item`: One list item. In: `List` only. Content: flow, ≤4000 chars.
  - `checked`: flag (`false` is kept: an open task). A task item: true when done, false when not.

- `Table`: Rows of cells. In: blocks. Content: `Tr`.

- `Tr`: A table row. In: `Table` only. Content: `Th`, `Td`.

- `Th`: A header cell. In: `Tr` only. Content: inline, ≤4000 chars.
  - `align`: `start` | `center` | `end`. Alignment.

- `Td`: A cell. In: `Tr` only. Content: inline, ≤4000 chars.
  - `align`: `start` | `center` | `end`. Alignment.

- `Quote`: Something someone said, such as a review comment. In: blocks. Content: flow, ≤4000 chars.
  - `author`: text ≤60. Who said it.
  - `location`: text ≤100. Where, such as "idle-shutdown.ts:142".

- `Code`: Preformatted text, such as a log excerpt or a diff. In: blocks. Content: raw text, ≤4000 chars.
  - `language`: `text` | `diff`, default `text`. diff colours added and removed lines.

- `Trend`: A small bar chart; bars over the threshold are highlighted. In: blocks. Content: none.
  - `values` (required): 2–30 numbers, comma-separated. Comma-separated numbers, oldest first.
  - `threshold`: number. Highlight bars above it.
  - `unit`: text ≤8. Such as "¥" or "ms".
  - `label`: text ≤60. What is charted.

- `Callout`: A highlighted note. In: blocks. Content: flow, ≤4000 chars.
  - `tone`: a tone, default `neutral`. Callout tone.
  - `title`: text ≤100. Bold first line.

### Inputs (card only)

- `Choice`: A single or multiple choice question. In: blocks. Content: `Option`.
  - `id` (required): field id. Answer key.
  - `label` (required): text ≤100. The question.
  - `description`: text ≤300. Help text.
  - `required`: flag. Must be answered.
  - `multiple`: flag. Several options may be chosen.
  - `min`: integer 1–50. multiple: fewest options.
  - `max`: integer 1–50. multiple: most options.

- `Option`: One option of a Choice; its text is the label. In: `Choice` only. Content: text, ≤100 chars.
  - `id` (required): option id. Answer value.
  - `note`: text ≤40. Shown beside it, such as "about 1 minute".
  - `badge`: text ≤16. A tag, such as "breaking".
  - `default`: flag. Chosen to begin with.
  - `then-status`: text ≤24. Status the card shows once this is chosen, until the sender updates it.
  - `then-tone`: a tone, default `neutral`. Tone of then-status.

- `Buttons`: A row of buttons answering one question; clicking one answers it. In: blocks. Content: `Button`.
  - `id` (required): field id. Answer key.
  - `label`: text ≤100. The question.
  - `description`: text ≤300. Help text.

- `Button`: With id: an answer inside Buttons. With href: a link anywhere, never an answer. In: blocks (link, `href`); `Buttons` (answer, `id`). Content: text, ≤32 chars.
  - `id`: option id. Answer value (inside Buttons).
  - `href`: link. Opens a link instead of answering.
  - `primary`: flag. The main action.
  - `destructive`: flag. A destructive action.
  - `then-status`: text ≤24. Status the card shows once this is chosen, until the sender updates it.
  - `then-tone`: a tone, default `neutral`. Tone of then-status.

- `Input`: A text answer. In: blocks. Content: none.
  - `id` (required): field id. Answer key.
  - `label` (required): text ≤100. The question.
  - `description`: text ≤300. Help text.
  - `placeholder`: text ≤100. Hint text.
  - `multiline`: flag. Several lines.
  - `max-length`: integer 1–4000. Longest answer; default 1000.
  - `required`: flag. Must be answered.

- `Submit`: The submit button; its text is the label. Left out, the platform adds one when needed. In: blocks. Content: text, ≤32 chars.
