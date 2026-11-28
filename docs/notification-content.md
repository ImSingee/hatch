# Notification content

A notification shows its content in one of three formats: **text**,
**Markdown** or a **card**. Markdown and cards also carry a one-line
**summary** for the places that can only show plain text, such as a phone's
push banner. Every format can ask for an answer with a `reply` form; a card
can also put its questions and buttons inside the card itself.

Every sender uses the same fields: Channel HTTP pushes, the App SDK
(`notify`, `updateNotification`), the CLI (`hatch notification send|update`,
which the platform Agent also uses) and the `NotificationService` RPCs. The
rules live in `packages/hatch-platform-api/` (`notification-content*.ts`,
`notification-card-markup.ts`, `notification-markdown.ts`,
`notification-reply*.ts`), shared by the platform, the CLI, the web and the
phone, so the CLI rejects exactly what the platform would. Routing, delivery,
edits and replies are described in [notifications.md](notifications.md).

## Formats

A push or send gives exactly one kind of content:

```jsonc
// Text: title (≤200) and an optional body (≤4000); summary optional.
{ "kind": "backup", "title": "Backup finished", "body": "14 GB in 3 minutes", "summary": "Nightly backup finished" }

// Markdown: the source (≤16 KiB); summary required.
{ "kind": "release", "markdown": "## v12 release notes\n- Fixed the login redirect", "summary": "v12 is live" }

// Card: card markup or a JSON tree; summary required.
{ "kind": "ci", "card": "<Card status=\"CI failed\" tone=\"danger\"><Title>PR #261</Title></Card>", "summary": "CI failed on PR #261" }
```

- **Text** is the default and what existing senders already send: a title and
  a plain-text body. Use it for short messages that read fine as a push
  banner ("Order 42 shipped").
- **Markdown** suits prose with some structure: release notes, a report, a
  list of changes. It needs no knowledge of the card components.
- **A card** suits a status that changes over time and has a shape: checks
  that pass or fail, a deploy with fields, a figure with a trend, a question
  with buttons. Senders compose it freely from the component catalog below.

Markdown and card notifications have no `title` or `body`; their content
carries its own heading. Giving `title` or `body` next to `markdown` or a
card, or `markdown` next to `card`, is rejected (`400`, `BAD_REQUEST` in the
RPCs).

Where the fields go:

| Sender                                        | Text                | Markdown                                         | Card                                             | Summary                                       |
| --------------------------------------------- | ------------------- | ------------------------------------------------ | ------------------------------------------------ | --------------------------------------------- |
| Channel HTTP push, App `notify`               | `title`, `body`     | `markdown`                                       | `card` (a markup string or a tree object)        | `summary`                                     |
| CLI `send` / `update`                         | `--title`, `--body` | `--markdown <text>`, `--markdown-file <path\|->` | `--card <markup\|json>`, `--card-file <path\|->` | `--summary`; `update --clear-summary`         |
| RPC `SendNotification` / `UpdateNotification` | `title`, `body`     | `markdown`                                       | `card_markup` or `card_json`                     | `summary`; `UpdateNotification.clear_summary` |

The App SDK also exports a `card` template tag that escapes every
interpolated value, so text from users, orders or logs can never open, close
or add an element or attribute:

```ts
import { card, notify } from '@hatch/app/notifications';

await notify({
  kind: 'order.shipped',
  summary: `Order ${order.id} shipped`,
  card: card`<Card icon="package" status="Shipped" tone="success">
  <Title>Order ${order.id} shipped</Title>
  <Fields><Field label="Customer">${order.customerName}</Field></Fields>
</Card>`,
});
```

Interpolate only into text and quoted attribute values. `null` and
`undefined` write nothing (an empty attribute counts as left out), dates
become ISO-8601, arrays of numbers comma-separated lists, and an array of
`cardFragment` results repeats elements. Never build markup by concatenating
strings yourself; use the tag, or a JSON tree, whose strings need no
escaping.

## Summary

The summary is one line of plain text that stands for the notification
wherever its content cannot be shown.

- One line, at most 200 characters (code points), trimmed. Line breaks are
  rejected (`summary must be one line, without line breaks`); `""` and `null`
  mean no summary. Markup is not interpreted: `<b>` stays as typed.
- Required for Markdown and cards; a send or an edit that ends without one is
  rejected with an error naming `summary`. Optional for text.
- It is shown in the phone push, the delivery log, the webhook and App
  envelope (`notification.summary`, and `notification.title` for Markdown and
  cards), the CLI and the RPC DTOs.
- It is never shown next to the content in the timeline. The timeline uses it
  only where it shows no content: a recalled notification's line, the
  collapsed row of low-priority notifications, and the title of the version
  history panel. The Agent chat opened for answers to a notification is named
  after it too.

The name a notification goes by outside its content is its **headline**: the
title of a text notification, the summary of the others
(`notificationHeadline`).

Write a summary that makes sense on a locked phone without the card: say what
happened and to what ("CI failed on PR #261: 2 unit tests time out"), not
"New notification" or "See card".

## What each surface shows

| Surface                      | Text                                                                   | Markdown                                                              | Card                                                          |
| ---------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Timeline (web and phone)     | Title and body                                                         | The rendered Markdown                                                 | The rendered card                                             |
| Phone push                   | With a summary: title and summary. Without: title and body (as before) | Title: the source name. Subtitle: the kind. Body: the summary         | Title: the source name. Subtitle: the kind. Body: the summary |
| Delivery log list            | The title, plus a line with the summary when there is one              | The summary                                                           | The summary                                                   |
| Delivery log detail          | The content and a "push text" entry                                    | The rendered content, the summary and the Markdown source             | The rendered card, the summary and the canonical card markup  |
| Webhook and App envelope     | `title`, `body` (as before)                                            | `title` = summary, `body` = plain text, plus `markdown` and `content` | `title` = summary, `body` = plain text, plus `content`        |
| CLI `hatch notification get` | Title and body                                                         | Summary and Markdown source                                           | Summary, plain text and canonical markup                      |

Notes:

- Phone push for Markdown and cards: the encrypted payload carries the source
  name as the title, the summary as the body and `ks: 1`, which tells the
  Notification Service Extension to show only the kind as the subtitle.
- Envelope fields (`notification.*`): `format` (`text`, `markdown` or `card`);
  `summary` (string or null); `title`, always a string (the headline);
  `body`, the body of a text notification or the plain-text version of the
  others; `markdown`, the source of a Markdown notification, otherwise null;
  `content`, the render tree of a Markdown or card notification, otherwise
  null.
- RPC DTOs (`NotificationSummary`, `NotificationRevision`) carry `format`,
  `summary`, `markdown`, `content_json` (the tree), `text` (plain text),
  `flag`, `icon` and `card_status`. `title` and `body` are set for text
  notifications only.

The **plain-text version** (envelope `body`, CLI, RPC `text`) has one line per
paragraph, field, step, list item or table row: a card's status (and flag)
first, `label: value` for fields, figures and progress bars, `✓ ✗ … ○ –` before
steps, `text (url)` for links and times in UTC.

## The render tree

Markdown and card markup both compile into one **render tree**, which is what
the platform stores and what the web and phone render with a single renderer
each (neither runs a Markdown library for notifications):

```text
Markdown ──(remark)──────┐
card markup ──(parser)───┼─→ checked against the catalog ─→ render tree ─→ web, phone, plain text
JSON tree ───────────────┘
```

A node is `{ "type": "...", "props": { ... }, "children": [ ... ] }` and text
leaves are strings. Components are capitalized (`Card`, `Steps`), inline
marks lowercase (`b`, `a`). Stored trees are normalized: props equal to their
default are left out, inline strings never contain a line break (that is a
`br` node) and no string is empty. A card's root is `Card`; a Markdown
notification's root is `Document`. A renderer that meets a type it does not
know renders a container's children and skips anything else.

Card markup is not stored. `contentToMarkup` writes the stored tree back as
canonical markup (see [Canonical markup](#canonical-markup)), which the CLI and
the delivery log show.

The same tree has a third renderer: native Apps draw cards with
`@hatch/ui/card` (`sdk-internal/ui/src/card`), which compiles markup with a
generated copy of the platform's dependency-free compiler
(`notification-content-compile.ts`). The three renderers stay separate
until the platform UI moves to NSH; `contentOutline`
(`notification-content-outline.ts`) states what each must show for a tree
(its controls and landmarks in order, and its texts), and parity tests hold
the web renderer, the phone's renderer model and `@hatch/ui` to it.

## Markdown

Markdown is GitHub-flavoured and compiles into the same components a card
uses:

| Markdown                                         | Becomes                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| `#`, `##`, `###`, `####`–`######`                | `Title` sized `xl`, `lg`, `md`, `sm`                                  |
| Paragraph                                        | `Text`; a soft line break reads as a space, a hard break as `br`      |
| `*em*`, `**strong**`, `~~strike~~`, `` `code` `` | `i`, `b`, `s`, `code`                                                 |
| Fenced or indented code                          | `Code` (`language="diff"` for a `diff` fence, plain text otherwise)   |
| Bullet, numbered and task lists                  | `List` (`ordered`) of `Item` (`checked` for task items)               |
| `>` quote                                        | `Quote`                                                               |
| Table                                            | `Table` of `Tr` with `Th` (first row) and `Td`, column alignment kept |
| `---`                                            | `Divider`                                                             |
| Links, reference links                           | `a`; a link that fails the [link rule](#security) becomes plain text  |
| Images                                           | A link to the image, labelled with its alt text; nothing is loaded    |
| Raw HTML                                         | Shown as the text it is                                               |
| Footnotes                                        | Shown as `[^label]` text                                              |

The source is at most 16 KiB and must not be empty; the tree is held to the
same limits as a card (200 elements, the `Document` root included, and 8
levels).

## Card markup

Card markup is a strict subset of XML. The "CI failed" card:

```xml
<Card icon="pr" status="CI failed" tone="danger" flag="Urgent">
  <Title>PR #261 · fix the login redirect</Title>
  <Fields><Field label="Branch" mono>fix/patch-body-framing</Field></Fields>
  <Steps mono>
    <Step state="failed" detail="2m 14s">e2e/login</Step>
    <Step state="done">unit</Step>
  </Steps>
  <Text tone="dimmed" size="sm">The other 10 checks passed. <a href="https://ci.example.com/runs/1">View the log</a></Text>
</Card>
```

### Syntax

- One root element, `<Card>`. Whitespace and comments may surround it;
  anything else is an error.
- Elements, attributes, text, comments (`<!-- … -->`) and CDATA sections
  (`<![CDATA[ … ]]>`). Names are case-sensitive.
- Attribute values are quoted with `"` or `'` and may not contain `<`. An
  attribute given twice is an error, and so is an attribute the component does
  not have. An empty value (`tone=""`) counts as left out, and so does a text
  value that is only whitespace (`summary=" "`): a required attribute given
  that way is reported as missing.
- A flag may be written bare (`mono`) or as `mono="true"` / `mono="false"`.
- Entities: only `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` and numeric references
  (`&#169;`, `&#xA9;`). A literal `&` must be written `&amp;`. Document types,
  entity definitions, processing instructions and the XML declaration are
  rejected, so no input can expand or fetch anything.
- CDATA saves escaping (`<![CDATA[a < b & c]]>`); its text follows the same
  whitespace rules as any other text, except inside `Code` and `Markdown`,
  where CDATA text is kept exactly (see below).
- Number lists are comma-separated (`values="210,180,260"`); times are
  ISO-8601 (`2026-11-25T02:14:00Z`; a date alone also works).

### Whitespace

Markup is indented freely, so text is tidied the way HTML reads it:

- In inline content (`Title`, `Text`, `Field`, `Step`, …) every run of
  spaces, tabs and line breaks becomes one space, trimmed at the start and
  end of the block and around `<br/>` (spaces inside `<b>`, `<a>` and other
  inline marks are kept). Write `<br/>` for a line break. Text that a CDATA
  section splits is tidied as one piece: `A <![CDATA[ ]]> B` reads `A B`.
- Text-only content (`Badge`, `Option`, `Button`, `code`, …) collapses the
  same way and is trimmed.
- Between blocks, whitespace is ignored; any other loose text is an error
  ("wrap it in `<Text>`").
- `Code` and `Markdown` keep their text as written, line breaks and spacing
  included, and are dedented: a first line break right after the opening tag,
  a last line holding only spaces, the indentation all non-blank lines share
  and trailing whitespace are removed. Start the text on the line after the
  opening tag to have the markup's own indentation removed; text that starts
  right after the tag keeps its following lines' indentation as written.
  Text in a CDATA section inside `Code` or `Markdown` is kept exactly, with
  no dedenting; the canonical markup writes text whose leading indentation
  or trailing line breaks matter that way, so it reads back unchanged.
- In a JSON tree, a `\n` in inline content becomes a line break (other runs
  of whitespace still become one space, also across adjacent strings, so
  `["A ", " B"]` reads `A B`), and `Code` and `Markdown` text is kept exactly,
  without dedenting.

### Limits

- A card's content is at most 16 KiB of UTF-8, measured as its compact
  canonical markup (no layout whitespace, each run of text written escaped
  or as CDATA, whichever is shorter), however it was written. Markup or a
  JSON tree as sent may be up to 64 KiB, checked before parsing, so the
  indented canonical markup `get` prints can always be sent back.
- At most 200 elements, the root and the elements a `Markdown` block compiles
  to included.
- At most 8 levels below the root. A JSON tree nested more than 64 levels
  (as deep as the markup parser reads) is rejected before its shape is
  checked, with the depth as its only problem.
- Text inside one element at most 4000 characters, or the component's own
  limit in the catalog.

### Errors

The platform and `hatch notification card check` (offline; exit 2 with
`invalid_content`) report up to 20 problems,
each with the line and column in the markup (or the path in a JSON tree), and
say what is allowed there:

```text
2:3: <Badges> is not a component; allowed inside <Card>: Column, Row, Grid, Box, Divider, Spacer, Collapse, Title, Text, Caption, Markdown, Badge, Icon, Progress, Stat, Fields, Steps, List, Table, Quote, Code, Trend, Callout, Choice, Buttons, Button, Input, Submit
1:26: <Text> cannot go inside <Fields>; allowed inside <Fields>: Field
1:7: <Card> tone must be one of neutral, info, success, warning, danger, working
1:15: "&" starts an entity: write &amp; for a literal "&"
1:23: </Crad> does not match <Card> opened at 1:1
1:16: <a> href must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link
children.0.props.tone: <Text> tone must be one of dimmed, neutral, info, success, warning, danger, working
```

### JSON tree

Instead of markup, a sender may give the tree itself: in the App SDK and
Channel push as an object, in the CLI and the `card_json` RPC field as JSON
text (a `card` string whose first character is `{` is read as JSON). It goes
through the same checks and normalization. Its root is `Card`; `Document`
is only the root a Markdown notification compiles to.

```json
{
  "type": "Card",
  "props": { "status": "Deployed", "tone": "success" },
  "children": [
    { "type": "Title", "children": ["v12 is live"] },
    {
      "type": "Fields",
      "children": [
        {
          "type": "Field",
          "props": { "label": "Version" },
          "children": ["v12"]
        }
      ]
    }
  ]
}
```

Props take their natural JSON types (`true`, numbers, a number array for
`Trend values`) or the same strings markup uses. A `Markdown` node is written
with its source as its only string child (`{ "type": "Markdown", "children":
["## Notes\n- one"] }`). A stored tree is accepted back as input as it
is (`get --json` and envelopes return a `Markdown` node with `props.source`
and its compiled blocks; the blocks are compiled again from the source), so
a card can be edited either as canonical markup or as its JSON tree.

### Canonical markup

`contentToMarkup` writes a tree as canonical markup: two-space indentation,
one block per line, inline content on one line, attributes in catalog order,
flags bare, defaults left out. Compiling it gives the same tree back, so
reading a card with `hatch notification get`, changing the markup and sending
it with `update` changes only what was edited. For example

```xml
<Card status="Deploy failed" tone="danger" icon="deploy">
  <!-- written by the release job -->
  <Title>
    Deploy of <b>v12</b>
    failed
  </Title>
  <Text mono="true" tone="neutral">Line one<br/>line   two</Text>
  <Code>
    step 3/5
      error: boom
  </Code>
</Card>
```

reads back as

```xml
<Card icon="deploy" status="Deploy failed" tone="danger">
  <Title>Deploy of <b>v12</b> failed</Title>
  <Text mono>Line one<br />line two</Text>
  <Code>step 3/5
  error: boom</Code>
</Card>
```

## Component catalog

`hatch notification card catalog [--json]` prints this catalog offline, and
`hatch notification card check (<markup|json> | --file <path|->)` checks a
card against it, printing the plain text, the reply form its inputs make and
the canonical markup. The
source of truth is `CONTENT_COMPONENTS` in
`packages/hatch-platform-api/notification-content.ts`.

Content models: **blocks** holds other components and no loose text;
**inline** holds text and inline marks (`b`, `a`, `Badge`, …); **flow**
holds either, and runs of inline content read as paragraphs; **text** holds
plain text only; **raw text** keeps text as written; **none** holds nothing.
A list of names allows only those. "Card only" components cannot appear in
Markdown trees. Styling exists only as these props: there are no colours,
pixel sizes or fonts.

- **Tones**: `neutral` (default), `info`, `success`, `warning`, `danger`,
  `working` (orange "in progress"). Text and captions may also be `dimmed`.
- **Spacings**: `xs`, `sm`, `md`, `lg`, `xl`.
- **Icon names** (`Card icon`, `Icon name`): `agent`, `app`, `pr`, `deploy`,
  `task`, `alert`, `shield`, `chart`, `clock`, `database`, `bug`, `message`,
  `package`, `money`.
- **Step states**: `done`, `failed`, `running`, `pending` (default),
  `skipped`.
- **Ids**: a field id (`Choice`, `Buttons`, `Input`) starts with a lowercase
  letter and has at most 40 lowercase letters, digits or `_`; an option id
  (`Option`, `Button`) is 1–40 lowercase letters, digits, `_`, `-` or `.`.

`status`, `flag` and `icon` go on `<Card>`. The platform stores them with the
tree and draws them in fixed places (the status pill, the urgent flag beside
it, the icon in place of the source tile); the CLI, list views and version
comparisons read them from there.

### Roots

| Component          | What it is                                                                        | Goes in  | Content | Props                                                                                         |
| ------------------ | --------------------------------------------------------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------- |
| `Card` (card only) | The card itself. Status, flag and icon are drawn by the platform in fixed places. | the root | blocks  | `icon`: an icon name; `status`: text ≤24; `tone`: a tone, default `neutral`; `flag`: text ≤16 |
| `Document`         | The root of a Markdown notification.                                              | the root | blocks  | —                                                                                             |

### Layout

| Component  | What it is                                                             | Goes in | Content | Props                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Column`   | Children stacked vertically.                                           | blocks  | blocks  | `gap`: a spacing; `align`: `start` \| `center` \| `end` \| `stretch`                                                                                   |
| `Row`      | Children side by side; stacks on narrow screens when it holds buttons. | blocks  | blocks  | `gap`: a spacing; `justify`: `start` \| `center` \| `end` \| `between`; `align`: `start` \| `center` \| `end` \| `baseline` \| `stretch`; `wrap`: flag |
| `Grid`     | Equal columns.                                                         | blocks  | blocks  | `columns`: integer 2–4, default `2`; `gap`: a spacing                                                                                                  |
| `Box`      | A group on a tinted surface.                                           | blocks  | blocks  | `surface`: `muted` \| `outline`, default `muted`; `padding`: `sm` \| `md` \| `lg`; `tone`: a tone, default `neutral`                                   |
| `Divider`  | A hairline between sections.                                           | blocks  | none    | —                                                                                                                                                      |
| `Spacer`   | Extra vertical space.                                                  | blocks  | none    | `size`: a spacing, default `md`                                                                                                                        |
| `Collapse` | Content hidden behind a toggle until opened.                           | blocks  | blocks  | `summary` (required): text ≤100                                                                                                                        |

### Text

| Component              | What it is                                                                         | Goes in | Content                                                        | Props                                                                                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Title`                | A heading.                                                                         | blocks  | inline, ≤300 chars                                             | `size`: `sm` \| `md` \| `lg` \| `xl`, default `md`; `align`: `start` \| `center` \| `end`; `lines`: integer 1–10                                                                                                         |
| `Text`                 | A paragraph.                                                                       | blocks  | inline, ≤4000 chars                                            | `size`: a spacing, default `md`; `weight`: `regular` \| `medium` \| `bold`, default `regular`; `tone`: `dimmed` or a tone, default `neutral`; `align`: `start` \| `center` \| `end`; `mono`: flag; `lines`: integer 1–10 |
| `Caption`              | Small dimmed text, such as "Updated 10:52".                                        | blocks  | inline, ≤4000 chars                                            | `tone`: `dimmed` or a tone, default `dimmed`; `align`: `start` \| `center` \| `end`; `lines`: integer 1–10                                                                                                               |
| `Markdown` (card only) | Markdown inside a card: headings, emphasis, lists, quotes, code, links and tables. | blocks  | Markdown source, compiled to blocks (each ≤4000 chars of text) | —                                                                                                                                                                                                                        |

### Inline marks

| Component | What it is                                           | Goes in        | Content             | Props                                                                                              |
| --------- | ---------------------------------------------------- | -------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `b`       | Bold.                                                | inline content | inline, ≤4000 chars | —                                                                                                  |
| `i`       | Italic.                                              | inline content | inline, ≤4000 chars | —                                                                                                  |
| `s`       | Struck through.                                      | inline content | inline, ≤4000 chars | —                                                                                                  |
| `code`    | Inline code.                                         | inline content | text, ≤4000 chars   | —                                                                                                  |
| `a`       | A link; opened only when tapped.                     | inline content | inline, ≤4000 chars | `href` (required): link                                                                            |
| `time`    | A time shown in the reader's language and time zone. | inline content | none                | `datetime` (required): ISO-8601 time; `format`: `datetime` \| `date` \| `time`, default `datetime` |
| `br`      | A line break.                                        | inline content | none                | —                                                                                                  |

### Markers

| Component | What it is                  | Goes in                  | Content         | Props                                                              |
| --------- | --------------------------- | ------------------------ | --------------- | ------------------------------------------------------------------ |
| `Badge`   | A small tinted label.       | blocks or inline content | text, ≤40 chars | `tone`: a tone, default `neutral`                                  |
| `Icon`    | An icon from the fixed set. | blocks or inline content | none            | `name` (required): an icon name; `tone`: a tone, default `neutral` |

### Data

| Component  | What it is                                                  | Goes in       | Content               | Props                                                                                                                                        |
| ---------- | ----------------------------------------------------------- | ------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Progress` | A bar filled to percent.                                    | blocks        | none                  | `label`: text ≤100; `value`: text ≤40; `percent` (required): number 0–100; `tone`: a tone, default `neutral`                                 |
| `Stat`     | One figure with its label.                                  | blocks        | none                  | `value` (required): text ≤40; `label` (required): text ≤60; `delta`: text ≤24; `tone`: a tone, default `neutral`                             |
| `Fields`   | Label and value pairs.                                      | blocks        | `Field`               | `mono`: flag                                                                                                                                 |
| `Field`    | One label and its value.                                    | `Fields` only | inline, ≤500 chars    | `label` (required): text ≤60; `mono`: flag                                                                                                   |
| `Steps`    | A checklist of steps or checks.                             | blocks        | `Step`                | `mono`: flag                                                                                                                                 |
| `Step`     | One step.                                                   | `Steps` only  | inline, ≤300 chars    | `state`: `done` \| `failed` \| `running` \| `pending` \| `skipped`, default `pending`; `detail`: text ≤60; `at`: ISO-8601 time; `href`: link |
| `List`     | A bulleted, numbered or task list.                          | blocks        | `Item`                | `ordered`: flag                                                                                                                              |
| `Item`     | One list item.                                              | `List` only   | flow, ≤4000 chars     | `checked`: flag (`false` is kept: an open task)                                                                                              |
| `Table`    | Rows of cells.                                              | blocks        | `Tr`                  | —                                                                                                                                            |
| `Tr`       | A table row.                                                | `Table` only  | `Th`, `Td`            | —                                                                                                                                            |
| `Th`       | A header cell.                                              | `Tr` only     | inline, ≤4000 chars   | `align`: `start` \| `center` \| `end`                                                                                                        |
| `Td`       | A cell.                                                     | `Tr` only     | inline, ≤4000 chars   | `align`: `start` \| `center` \| `end`                                                                                                        |
| `Quote`    | Something someone said, such as a review comment.           | blocks        | flow, ≤4000 chars     | `author`: text ≤60; `location`: text ≤100                                                                                                    |
| `Code`     | Preformatted text, such as a log excerpt or a diff.         | blocks        | raw text, ≤4000 chars | `language`: `text` \| `diff`, default `text`                                                                                                 |
| `Trend`    | A small bar chart; bars over the threshold are highlighted. | blocks        | none                  | `values` (required): 2–30 numbers, comma-separated; `threshold`: number; `unit`: text ≤8; `label`: text ≤60                                  |
| `Callout`  | A highlighted note.                                         | blocks        | flow, ≤4000 chars     | `tone`: a tone, default `neutral`; `title`: text ≤100                                                                                        |

### Inputs (card only)

| Component | What it is                                                                             | Goes in                                         | Content          | Props                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Choice`  | A single or multiple choice question.                                                  | blocks                                          | `Option`         | `id` (required): field id; `label` (required): text ≤100; `description`: text ≤300; `required`: flag; `multiple`: flag; `min`: integer 1–50; `max`: integer 1–50                |
| `Option`  | One option of a Choice; its text is the label.                                         | `Choice` only                                   | text, ≤100 chars | `id` (required): option id; `note`: text ≤40; `badge`: text ≤16; `default`: flag; `then-status`: text ≤24; `then-tone`: a tone, default `neutral`                               |
| `Buttons` | A row of buttons answering one question; clicking one answers it.                      | blocks                                          | `Button`         | `id` (required): field id; `label`: text ≤100; `description`: text ≤300                                                                                                         |
| `Button`  | With id: an answer inside Buttons. With href: a link anywhere, never an answer.        | blocks (link, `href`); `Buttons` (answer, `id`) | text, ≤32 chars  | `id`: option id; `href`: link; `primary`: flag; `destructive`: flag; `then-status`: text ≤24; `then-tone`: a tone, default `neutral`                                            |
| `Input`   | A text answer.                                                                         | blocks                                          | none             | `id` (required): field id; `label` (required): text ≤100; `description`: text ≤300; `placeholder`: text ≤100; `multiline`: flag; `max-length`: integer 1–4000; `required`: flag |
| `Submit`  | The submit button; its text is the label. Left out, the platform adds one when needed. | blocks                                          | text, ≤32 chars  | —                                                                                                                                                                               |

## Inline actions

A card can hold its questions where they belong instead of below it. Input
components may go anywhere among the card's blocks, and the whole card is one
form:

```xml
<Card status="Incident" tone="danger" flag="Urgent">
  <Title>The backend restarted 3 times in 10 minutes</Title>
  <Progress label="Memory peak" value="498 / 512 MB" percent="97" />
  <Choice id="plan" label="What should we do?" required>
    <Option id="rollback" note="about 1 minute" then-status="Rolling back" then-tone="working">Roll back to v11</Option>
    <Option id="raise" note="takes effect now">Raise the memory limit to 1 GB</Option>
  </Choice>
  <Row justify="end"><Submit>Confirm</Submit></Row>
</Card>
```

- **`Choice`** with `Option`s becomes a `single` field, or a `multiple` field
  with `multiple` (`min` and `max` need `multiple`). An option's text is its
  label; `note`, `badge` and `default` become the option's note, badge and
  the field's default (one default for a single choice).
- **`Buttons`** with `Button id=…` children becomes a `buttons` field: 1–4
  buttons, labels up to 32 characters, `primary` and `destructive` as in a
  `reply` form. Clicking a button answers.
- **`Input`** becomes a `text` field (`placeholder`, `multiline`,
  `max-length`, default 1000, at most 4000).
- **`Submit`** sets the submit button's label (at most one per card). Left
  out, the platform adds one when the form needs it. It needs a `Choice`,
  `Buttons` or `Input` to submit.
- **`Button href=…`** outside `Buttons` is a plain link button, drawn grey
  with an arrow. It never answers and cannot be `primary`, `destructive` or
  carry `then-status`. A `Button` inside `Buttons` needs an `id` and no
  `href`.

Markup defaults differ from a hand-written `reply`: `Choice` and `Input` are
optional unless marked `required`, while `reply` fields default to
`required: true`. `Buttons` is always required.

The platform compiles the inputs in document order into the notification's
ordinary reply form (stored as `reply`; at most 10 fields, unique ids, 2–50
options per choice), so rounds, answer checks, the phone's quick actions,
response routes and `hatch notification respond` work exactly as for a
hand-written form. A card whose only input is one `Buttons` (or one required
`Input`) can be answered straight from the push. A request that has inline
inputs and also a `reply` is rejected (`400`).

**After an answer**, the inputs turn read-only in place and show what was
chosen; the platform's "✓ Ada chose …" line stays in its fixed place below.
If the chosen `Option` or `Button` has `then-status` (with an optional
`then-tone`), the card's status pill shows it instead of the status, and the
flag is hidden, until the sender next edits the notification (its `editedAt`
is later than the answer). This is display only and creates no revision; the
sender is expected to update the card with the real outcome.

## Reply forms in every format

`reply` works with text, Markdown and cards alike and is drawn below the
content. These additions apply to hand-written forms and to forms compiled
from inline inputs:

- `buttons` options may be `primary` (drawn filled); `destructive` as before.
- `single` and `multiple` options may have a `note` (≤40, such as "about 1
  minute") and a `badge` (≤16, such as "breaking").
- `single` fields take `default` (one option id) and `multiple` fields a
  list of them; the form starts with those options chosen.
- When the last field is a required `buttons` field, its buttons replace the
  submit button: clicking one submits the whole form with that answer.

`note` and `badge` on a `buttons` option, `primary` or `destructive` on a
choice option, and `default` on a `buttons` field are rejected.

## Updating a notification

Update the notification you already sent when the same thing changes (a pull
request's checks, a deploy, an order) instead of sending a new one: it moves
to the end of the timeline, phones replace it in place, and earlier versions
stay in its history. An edit may switch to any format:

- `markdown` or a card (markup or tree) switches to that format. The summary
  is the one given, otherwise the current one; with neither, the edit is
  rejected naming `summary`.
- `title` and `body` on a text notification change those fields. On a
  Markdown or card notification they switch it to text and need `title`; the
  summary is dropped unless the edit gives one, since it named the old
  content and a text notification's summary replaces the body in pushes.
- `summary` replaces the summary; `clear_summary` (`--clear-summary`) removes
  it, which only a text notification allows.
- Otherwise, without `summary`, the current summary is kept.
- Inline inputs are recompiled with the card. A different form starts a new
  round; the same form again changes nothing. An edit whose content no
  longer has inline inputs removes their form and starts a new round, unless
  the same edit gives a `reply`. While the card keeps its inputs, a `reply`
  cannot replace them (`400`): send the card with new inputs instead. A
  hand-written `reply` survives a format switch unless the edit changes it.

The CLI reads the current card with `hatch notification get <id>` (canonical
markup) and writes it back with `hatch notification update <id> --card-file
card.xml`.

## Security

- Content is data: there is no HTML, CSS, script or image, and styling
  exists only as the catalog's tokens. Raw HTML in Markdown is shown as text.
  Images would reveal the reader's address to whoever hosts them, so Markdown
  images become links.
- Every link (`a href`, `Step href`, `Button href`, Markdown links) follows
  the rule for a notification's `url`: an absolute URL a device can open (a
  web page, another app by its own scheme such as `mailto:`, or a `hatch://`
  page); schemes that only run inside the current document (`javascript:`,
  `data:`, `blob:`, `file:`, `about:`) are rejected. Links open only when
  tapped, through the same external-link policy as every other surface.
- The size is checked before parsing, and the element count, depth and every
  text have limits. The parser supports no entity definitions.
- The platform's own parts of a notification (the source and kind header, the
  status pill, the flag, the answer line, the "Edited N times" entry) are drawn
  in fixed places that markup cannot reach, so whoever holds a Channel token
  cannot imitate them.
- An answer handed to the Agent still holds only positions and the routes'
  instructions, never the notification's content.

## Examples

These are `CARD_EXAMPLES` and `MARKDOWN_EXAMPLE` in
`packages/hatch-platform-api/notification-content-examples.ts`, which tests
and acceptance send. They reproduce every card of the timeline and
action-card designs, in the designs' language, plus three free-form cards.
Workflows were removed from the platform, so the designs' Workflow examples
are App scheduled tasks here.

### Stats (`digest`)

Reproduces the design's "Stats" card (a Workflow digest in the design; the figures now count App scheduled task runs). Source `Agent`, kind `每日摘要`.

Summary: `过去 24 小时一切正常`

```xml
<Card icon="chart">
  <Title>过去 24 小时的平台概况</Title>
  <Text>一切正常。耗时最长的是「同步订单」，跑了 4 分 31 秒，比平时慢了大约 1 分钟。</Text>
  <Grid columns="3">
    <Stat value="12" label="定时任务运行" />
    <Stat value="3" label="次部署" />
    <Stat value="0" label="失败" />
  </Grid>
</Card>
```

### Fields (`deploy`)

Reproduces the design's "Fields" card. Source `记账本`, kind `部署`.

Summary: `v12 已部署到生产`

```xml
<Card icon="app" status="已上线" tone="success">
  <Title>v12 已部署到生产</Title>
  <Text>这次部署包含 2 个改动，数据迁移已完成，旧版本的实例已经停掉。</Text>
  <Fields>
    <Field label="版本">v12</Field>
    <Field label="耗时">48 秒</Field>
    <Field label="实例">2 个运行中</Field>
  </Fields>
</Card>
```

### Steps (`task`)

Reproduces the design's "Steps" card. Source `Agent`, kind `任务`.

Summary: `「记账本」存储迁移进行中`

```xml
<Card icon="agent" status="进行中" tone="working">
  <Title>把「记账本」迁移到新的存储 API</Title>
  <Text>迁移脚本已生成，正在预览环境里验证。</Text>
  <Steps>
    <Step state="done" detail="09:41">读取现有 schema</Step>
    <Step state="done" detail="09:52">生成迁移脚本</Step>
    <Step state="running" detail="进行中">在预览环境验证</Step>
    <Step>部署到生产</Step>
  </Steps>
</Card>
```

### Steps, updated (`task-done`)

Reproduces the design's "Steps, updated" card. Source `Agent`, kind `任务`.

Summary: `「记账本」已迁移到新的存储 API`

```xml
<Card icon="agent" status="已完成" tone="success">
  <Title>把「记账本」迁移到新的存储 API</Title>
  <Text>迁移完成，「记账本」现在跑在新的存储 API 上，旧数据全部保留。</Text>
  <Steps>
    <Step state="done" detail="09:41">读取现有 schema</Step>
    <Step state="done" detail="09:52">生成迁移脚本</Step>
    <Step state="done" detail="10:27">在预览环境验证</Step>
    <Step state="done" detail="10:54">部署到生产</Step>
  </Steps>
</Card>
```

### Progress (`pr261-running`)

Reproduces the design's "Progress" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 的 CI 正在运行`

```xml
<Card icon="pr" status="CI 运行中" tone="info">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>已推送 2 个提交，检查正在运行。</Text>
  <Fields>
    <Field label="分支" mono>fix/patch-body-framing</Field>
  </Fields>
  <Progress label="检查" value="3 / 14" percent="21" tone="info" />
</Card>
```

### Checks with actions (`pr261-failed`)

Reproduces the design's "Checks with actions" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 的 CI 失败了，等你处理`

```xml
<Card icon="pr" status="CI 失败" tone="danger">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>14 项检查里有 2 项失败，都是 <code>src/agent/runtime.test.ts</code> 里的 5 秒超时。</Text>
  <Steps mono>
    <Step state="done" detail="41 秒">check:types</Step>
    <Step state="done" detail="18 秒">lint</Step>
    <Step state="failed" detail="2 个用例超时">test:unit</Step>
    <Step state="done" detail="3 分 02 秒">test:browser</Step>
  </Steps>
  <Fields>
    <Field label="其余">10 项通过</Field>
  </Fields>
  <Buttons id="next">
    <Button id="fix" primary then-status="修复中" then-tone="working">修复它</Button>
    <Button id="skip">先不管</Button>
  </Buttons>
</Card>
```

### Primary and secondary buttons (`pr261-passed`)

Reproduces the design's "Primary and secondary buttons" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 可以合并了`

```xml
<Card icon="pr" status="CI 通过" tone="success">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>14 项检查全部通过，已有 1 个 Approve，没有冲突，可以合并。</Text>
  <Fields>
    <Field label="分支" mono>fix/patch-body-framing</Field>
    <Field label="评审">1 Approve</Field>
  </Fields>
  <Progress label="检查" value="14 / 14" percent="100" tone="success" />
  <Buttons id="merge">
    <Button id="merge" primary then-status="合并中" then-tone="working">Merge</Button>
    <Button id="wait">先不合并</Button>
  </Buttons>
</Card>
```

### Updated card (`pr261-merged`)

Reproduces the design's "Updated card" card. Source `hatch`, kind `PR #261`.

Summary: `PR #261 已合并`

```xml
<Card icon="pr" status="已合并">
  <Title>frame PATCH bodies when proxying to app backends</Title>
  <Text>已 squash 合并到 master，分支已删除。</Text>
</Card>
```

### Log excerpt with urgent flag (`sync-failed`)

Reproduces the design's "Log excerpt with urgent flag" card (a Workflow failure in the design; an App scheduled task here). Source `同步订单`, kind `定时任务`.

Summary: `定时任务「同步订单」第 3 步失败`

```xml
<Card icon="task" status="运行失败" tone="danger" flag="紧急">
  <Title>第 3 步「写入数据库」失败</Title>
  <Text>已自动重试 2 次，都停在同一步。上游数据里有重复的订单号。</Text>
  <Code>step 3/5  write_orders
error: duplicate key value violates unique constraint "orders_pkey"
  detail: Key (id)=(ord_8841) already exists.
  at insertBatch (sync-orders.ts:88)</Code>
  <Buttons id="next">
    <Button id="investigate" primary then-status="排查中" then-tone="working">让 Agent 排查</Button>
    <Button id="retry" then-status="重试中" then-tone="info">直接重试</Button>
    <Button id="ignore">忽略</Button>
  </Buttons>
</Card>
```

### Quote, text input or buttons (`pr258`)

Reproduces the design's "Quote, text input or buttons" card. Source `hatch`, kind `PR #258`.

Summary: `PR #258 有 1 条新评审意见`

```xml
<Card icon="pr" status="有新评审" tone="warning">
  <Title>Stop idle serverless app backends</Title>
  <Text>Bryan 留了 1 条需要处理的评审意见。</Text>
  <Quote author="Bryan" location="idle-shutdown.ts:142">这里的等待没有上限，实例卡住的话会一直等下去。</Quote>
  <Input id="how" label="告诉 Agent 怎么改（可选）" placeholder="例如：上限设 30 秒，超时后强制停止" multiline />
  <Row justify="between" wrap>
    <Button href="https://github.com/ImSingee/hatch/pull/258">查看 PR</Button>
    <Buttons id="next">
      <Button id="later">稍后处理</Button>
      <Button id="fix" primary then-status="修复中" then-tone="working">修复它</Button>
    </Buttons>
  </Row>
</Card>
```

### Usage progress (`usage`)

Reproduces the design's "Usage progress" card. Source `平台`, kind `用量`.

Summary: `本月 Agent 用量已到 82%`

```xml
<Card icon="chart" status="接近上限" tone="warning">
  <Title>本月 Agent 用量已到 82%</Title>
  <Text>按最近 7 天的速度，大约在 24 号用完。用完后新的 Agent Run 会排队到下月。</Text>
  <Progress label="已用" value="82%" percent="82" tone="warning" />
  <Buttons id="next">
    <Button id="light" primary then-status="已调整" then-tone="success">后台任务改用轻量模型</Button>
    <Button id="ok">知道了</Button>
  </Buttons>
</Card>
```

### Title and body only (`remind`)

Reproduces the design's "Title and body only" card. Source `提醒`, kind `会议`.

Summary: `15 分钟后和 Bryan 过 serverless 方案`

```xml
<Card icon="clock">
  <Title>15 分钟后：和 Bryan 过一遍 serverless 方案</Title>
  <Text>你昨天让我在会前提醒你。相关的 PR #258 还有 1 条评审意见没处理。</Text>
  <Buttons id="next">
    <Button id="snooze" then-status="已推迟">10 分钟后再提醒</Button>
    <Button id="ok">知道了</Button>
  </Buttons>
</Card>
```

### Buttons (`perm`)

Reproduces the design's "Buttons" card. Source `Agent`, kind `权限申请`.

Summary: `「记账本」想访问 api.exchangerate.host`

```xml
<Card icon="shield" status="等你批准" tone="warning">
  <Title>允许「记账本」访问外部网络</Title>
  <Text>迁移脚本需要从 <code>api.exchangerate.host</code> 拉取汇率。只放行这一个域名，不影响其它网络策略。</Text>
  <Fields>
    <Field label="域名" mono>api.exchangerate.host</Field>
    <Field label="方向">仅出站 HTTPS</Field>
    <Field label="有效期">永久，可随时撤销</Field>
  </Fields>
  <Buttons id="decision">
    <Button id="allow" primary then-status="已批准" then-tone="success">允许</Button>
    <Button id="once" then-status="已批准一次" then-tone="success">只允许这一次</Button>
    <Button id="deny" destructive then-status="已拒绝">拒绝</Button>
  </Buttons>
</Card>
```

### Single choice (`alert`)

Reproduces the design's "Single choice" card. Source `记账本`, kind `告警`.

Summary: `记账本后端 10 分钟内重启了 3 次`

```xml
<Card icon="app" status="异常" tone="danger" flag="紧急">
  <Title>后端实例 10 分钟内重启了 3 次</Title>
  <Text>每次都是内存超过上限后被终止，从 v12 上线后开始出现。</Text>
  <Progress label="内存峰值" value="498 / 512 MB" percent="97" tone="danger" />
  <Choice id="plan" label="要怎么处理？" required>
    <Option id="rollback" note="约 1 分钟" then-status="回滚中" then-tone="working">回滚到 v11</Option>
    <Option id="raise" note="立即生效" then-status="调整中" then-tone="working">把内存上限提到 1 GB</Option>
    <Option id="dig" then-status="排查中" then-tone="working">保持现状，让 Agent 排查</Option>
  </Choice>
  <Row justify="end">
    <Submit>确认</Submit>
  </Row>
</Card>
```

### Multiple choice (`deps`)

Reproduces the design's "Multiple choice" card. Source `Agent`, kind `依赖更新`.

Summary: `有 4 个依赖可以升级`

```xml
<Card icon="package" status="等你选择" tone="warning">
  <Title>有 4 个依赖可以升级</Title>
  <Text>补丁版本我已经跑过测试。标了「破坏性」的那个需要单独迁移，默认没有勾选。</Text>
  <Choice id="upgrade" label="选择要升级的依赖" multiple required>
    <Option id="mantine" badge="补丁" default>@mantine/core</Option>
    <Option id="vitest" badge="补丁" default>vitest</Option>
    <Option id="zod" badge="补丁" default>zod</Option>
    <Option id="drizzle" badge="破坏性">drizzle-orm</Option>
  </Choice>
  <Submit>升级选中的</Submit>
</Card>
```

### Free-form: spending overview (`spending`)

A free-form card that is not in the designs: spending overview. Source `记账本`, kind `月度账单`.

Summary: `本月支出 ¥3,482，超出预算 12%`

```xml
<Card icon="money" status="超支" tone="warning">
  <Row justify="between" align="end">
    <Column gap="xs">
      <Text size="xl" weight="bold">¥3,482</Text>
      <Caption>本月支出</Caption>
    </Column>
    <Badge tone="danger">+12% 环比</Badge>
  </Row>
  <Trend values="210,180,260,240,390,410,520" threshold="400" unit="¥" label="最近 7 天" />
  <Divider />
  <Grid columns="3">
    <Stat value="¥1,204" label="餐饮" />
    <Stat value="¥980" label="交通" />
    <Stat value="¥1,298" label="其它" />
  </Grid>
</Card>
```

### Free-form: release comparison (`release`)

A free-form card that is not in the designs: release comparison. Source `记账本`, kind `发布`.

Summary: `v12 已上线，冷启动快了一倍`

```xml
<Card icon="deploy" status="已上线" tone="success">
  <Title>v12 与 v11 对比</Title>
  <Table>
    <Tr><Th>指标</Th><Th>v11</Th><Th>v12</Th></Tr>
    <Tr><Td>冷启动</Td><Td>2.1 s</Td><Td><b>0.9 s</b></Td></Tr>
    <Tr><Td>内存峰值</Td><Td>498 MB</Td><Td><b>301 MB</b></Td></Tr>
  </Table>
  <Callout tone="info" title="空闲 5 分钟自动休眠">第一次请求会多等约 1 秒。</Callout>
  <Collapse summary="查看 3 项改动">
    <List>
      <Item>修复登录重定向</Item>
      <Item>后端改用 serverless 模式</Item>
      <Item>空闲 5 分钟自动休眠</Item>
    </List>
  </Collapse>
</Card>
```

### Free-form: incident timeline (`incident`)

A free-form card that is not in the designs: incident timeline. Source `订单`, kind `事故`.

Summary: `订单同步中断，约 40 笔订单延迟`

```xml
<Card icon="alert" status="处理中" tone="working">
  <Title>订单同步中断</Title>
  <Box surface="muted">
    <Fields>
      <Field label="影响">约 40 笔订单延迟</Field>
      <Field label="开始"><time datetime="2026-11-25T02:14:00Z" /></Field>
    </Fields>
  </Box>
  <Steps>
    <Step state="done" at="2026-11-25T02:14:00Z">发现重复订单号</Step>
    <Step state="done" at="2026-11-25T02:20:00Z">暂停写入</Step>
    <Step state="running">按订单号改为 upsert</Step>
    <Step state="pending">补写延迟的订单</Step>
  </Steps>
  <Text size="sm" tone="dimmed"><a href="hatch://app/orders#/manage">打开订单 App</a></Text>
</Card>
```

### Markdown (`release-notes`)

A Markdown notification with a heading, inline code, a list, a table and a link. Source `发布助手`, kind `发布`.

Summary: `v12 已发布到生产`

```text
## v12 发布说明

后端改用 `serverless` 模式。

- 修复登录重定向
- 空闲 5 分钟自动休眠

| 指标 | v11 | v12 |
| --- | --- | --- |
| 冷启动 | 2.1 s | 0.9 s |

[完整变更记录](https://github.com/ImSingee/hatch/releases)
```
