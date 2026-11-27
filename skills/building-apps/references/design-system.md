# Design system for native-runtime Apps

Read this before writing the frontend of an App whose `app.runtime` is
`native`. Its screens are built only from `@hatch/ui`, a closed catalogue of
components that look like the Hatch platform around the App and adapt to
phones, tablets, desktops and the web by themselves.

## Rules

1. Import every piece of UI, and the state primitives, from `@hatch/ui`:
   `import { Page, Button, signal, mount } from '@hatch/ui'`. Do not import
   `nsh` or `nsh/base` outside `app/custom/`.
2. Start the App with `mount(App)` from `@hatch/ui` in `app/main.tsx`. It
   follows the viewer's theme and accent and hosts toasts and confirmations.
3. No component takes `class` or `style`. Vary a component only through its
   typed props (`kind`, `tone`, `size`, `gap`, `width`). The type checker
   rejects anything else, and the deploy check rejects colours and sizes
   written in source.
4. Components are functions that run once. Read a signal where it is used,
   inside JSX or a function (`{count()}`, `title={note().title}`), never in the
   component body to copy it.
5. Show a list with `<Each of={items()} key={(item) => item.id}>` and a
   condition with `<If when={...}>`, both from `@hatch/ui`. Do not use
   `array.map` in JSX.
6. `app/custom/` is the escape hatch for what the catalogue cannot express
   (a canvas, a game). Files there may use `nsh` directly but still only theme
   tokens: classes such as `bg-card`, `text-muted-foreground`,
   `rounded-(--radius-md)`. The build log lists every custom file.

## Which pattern fits which screen

| The screen                                             | Use                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| The App has two to six top-level areas                 | `AppShell` with one section per area                           |
| A list of records, each with its own detail            | `ListDetailPage`                                               |
| Creating or editing one record                         | `FormPage` (a short edit inside a screen: `Dialog`)            |
| Preferences                                            | `SettingsPage` with `Section`s of `List`s                      |
| An overview with figures                               | `DashboardPage` with `Stat`s and `Card`s                       |
| Drilling down from a row to its own screen and back    | `NavStack` of `Page`s                                          |
| Switching between views of the same content            | `Tabs`                                                         |
| Records people compare, sort and scan in columns       | `DataTable`                                                    |
| A handful of items with a title, a meta line and value | `List` of `ListItem`s                                          |
| Nothing to show yet                                    | `EmptyState`, inside the page or the list                      |
| Content that is loading                                | `Skeleton` in its shape; `List` and `DataTable` take `loading` |
| Anything else                                          | `Page` with `Section`s and `Card`s                             |

An App with one screen is a `Page` (or a pattern page) passed to `mount`; it
needs no `AppShell`. Each `AppShell` section's `content` is usually a `Page`,
a pattern page or a `NavStack`.

## Layout and spacing

- The App's layout follows its own pane, not the screen: an App in a narrow
  desktop window lays out as on a phone. Components decide this themselves;
  do not branch on the platform or the width in App code.
- `Page` gives every screen its title row, padding and scrolling. Pick its
  `width`: `narrow` for forms and settings, `default` for most screens,
  `wide` for dashboards and tables.
- Group related content in a `Card` or a `Section`. Do not put a `Card` in a
  `Card`; inside a card, separate groups with `Divider` or a `List`.
- Space with the `gap` of `Stack`, `Row`, `Grid`, `Card`, `Section` and
  `Page` only. The defaults are the Desk rhythm: 24 points between a page's
  blocks, 16 between fields, 12 inside a card, 8 between buttons. Change a
  gap one step at most, and only to show that things belong together (smaller)
  or apart (larger).
- Lay out side by side with `Row` (`collapse` turns it into a column in a
  compact pane) and in columns with `Grid`, which drops columns as the pane
  narrows.
- Put buttons in a `Row`: a lone button in a column keeps its own width.
  `fullWidth` stretches one across, for the main action at the foot of a
  phone form.

## Hierarchy

- One page title per screen, from `Page` or the pattern page. Inside it, use
  `Card` and `Section` titles; reach for `Heading` only for text that is a
  heading outside those.
- One primary button per view: its main action. Secondary actions are
  `default` buttons; low-emphasis ones in rows and toolbars are `subtle`;
  further actions go in a `Menu`. Destructive actions are `danger` and ask
  with `AlertDialog.confirm` first when they cannot be undone.
- Colour carries meaning, not decoration: `tone` says success, warning,
  danger or info and is always paired with a word or an icon. Keep ordinary
  metadata neutral; do not give each category its own colour.
- The accent (each viewer's own choice) marks the main action, the current
  navigation item and selection. Never choose colours: the theme does.
- Prefer text to icons. An icon without text (`IconButton`) needs a `label`.

## Forms

- Wrap fields in a `Form` with a stable `id`, and give every field a `name`.
  The form keeps the values, saves a draft on the device while the user types
  (a shell may stop a hidden App) and restores it, checks `required` fields,
  and passes the values to `onSubmit`. The draft is deleted after a
  successful submit. Password fields are never saved.
- Submit with `<Button type="submit" label="…" />`; it shows a spinner while
  `onSubmit`'s promise runs. Throw an `Error` from `onSubmit` to show its
  message above the fields.
- Every field has a visible `label`. Use `description` for what to enter and
  `placeholder` only for an example. The one exception is a search field at
  the top of a list: `kind="search"` with `labelHidden`, whose magnifier and
  placeholder ("Search plants") say what it does; its `label` still names it
  for screen readers. `ListDetailPage`'s `search` is such a field. Errors say what to do: "Enter a date
  after the start date", not "Invalid".
- Pick the control by the data: `TextField` (with `kind` for email, URL,
  password, phone, search), `TextArea`, `NumberField`, `Select` for one of
  many, `RadioGroup` for one of a few that should all be visible, `Checkbox`
  for options set on submit, `Switch` for settings that apply at once,
  `Combobox` for searching many or choosing several, `DatePicker`, `Slider`
  for approximate values.

## Feedback

- `Toast` reports the outcome of an action that happened ("Saved"), with
  Undo where the action can be undone. Do not confirm reversible actions.
- `AlertDialog.confirm` asks before an action that cannot be undone;
  `AlertDialog.alert` tells something the user must read before going on.
- `Dialog` holds a short task in its own window (rename, a quick add);
  `Sheet` a longer side task or filters. On phones both come up from the
  bottom.
- `Tooltip` adds a hint on desktops only. Touch screens never see it, so
  never put information only in a tooltip.

## Copy

- Sentence case everywhere: titles, buttons, labels, menu items, badges.
- Buttons and menu items start with a verb that names the result: "Add
  plant", "Export CSV", "Delete note". Avoid "OK", "Yes" and "Submit".
- Labels are nouns without a colon. Descriptions are one sentence with a
  full stop; labels, titles and buttons have none.
- Say what happened and what to do next. Error messages never blame the
  user and never show codes or stack traces.
- Write numbers, dates and times with `Intl` in the user's locale. Use real,
  specific words from the App's domain; no lorem ipsum, no "Item 1".
- Write the App's UI in the language the user asked in.

## Platforms

The same source runs everywhere; the components adapt:

| Where                           | What changes                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| Touch (phones, tablets)         | Controls and rows are at least 44 points tall; row actions always show; no tooltips              |
| Phones                          | `Dialog`, `Select`, `Combobox`, `DatePicker` and `Menu` come up as sheets from the bottom        |
| A wide pane (720 points up)     | `AppShell` shows a sidebar; `ListDetailPage` (960 up) shows the list and the detail side by side |
| A narrow pane on a touch screen | `AppShell` shows a bottom tab bar                                                                |
| A narrow pane with a pointer    | `AppShell` shows a row of tabs at the top                                                        |
| Compact panes (below 600)       | `Grid` shows one column, `Row collapse` stacks, page padding shrinks                             |

The platform changes the habits, never the brand. On iOS and Android (the
Mobile app, and native shells later) the components take that platform's
font (SF Pro, Roboto), navigation, controls, sheets, touch targets and
pressed feedback; the colours, the accent, the radius scale, the icons and
the App's content stay the theme's. The web, macOS and Windows keep the Desk
look.

| Platform | What it looks like                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | Large page titles; a back button that names the page it leads to; a floating tab bar; fields as inset rows (label above the value); sheets with a grabber and Cancel; 44-point targets    |
| Android  | Material 3: a top app bar; a navigation bar with a tinted pill; outlined fields with the label on the border; pill buttons; bottom sheets with a drag handle; snackbars; 48-point targets |
| Web      | The Desk look (`DESIGN.md`)                                                                                                                                                               |

Write the same App for all of them: never read the platform in App code,
never pass sizes or colours to make one platform look like another.

## Addresses and titles

The library keeps the App's address and title in the shell; App code does
not call the bridge for them.

- `AppShell`'s selected section is the first part of the address,
  `/<section id>`: a link, a pin or a reload opens that section, and the
  shell's back button and links move between sections. Use short, stable,
  lowercase section ids.
- A `NavStack` given `routes` keeps its pages in the rest of the address.
  `path` turns the stack into an address and `parse` turns an address back
  into the stack, first page included; `null` shows the first page. Write
  the return type on `parse`, so the routes' literal types are kept:

  ```tsx
  type Route = { name: 'list' } | { name: 'note'; id: string };
  const notes = createNavStack<Route>([{ name: 'list' }]);

  <NavStack
    stack={notes}
    routes={{
      path: (stack) => {
        const top = stack[stack.length - 1];
        return top?.name === 'note' ? `/${top.id}` : '';
      },
      parse: (path): Route[] | null => {
        const id = /^\/([\w-]+)$/.exec(path)?.[1];
        return id ? [{ name: 'list' }, { name: 'note', id }] : null;
      },
    }}
  >
    {(route) => (route.name === 'note' ? <Note id={route.id} /> : <Notes />)}
  </NavStack>;
  ```

  Inside an `AppShell` section the stack's address follows the section's:
  `/notes/42`. Each page shows its own data from the route (`Note` loads note
  `42`), because a deep link opens it without the pages before it running.

- The title of the `Page` on screen is the App's title in the shell: the
  selected section's page, the top page of a stack, an item's page in a
  `ListDetailPage`. Give each `Page` the specific name of what it shows
  ("Tomato seedlings", not "Detail").

## Catalogue

Generated from the component types by `sdk-internal/ui/scripts/generate.ts`;
do not edit between the markers.

<!-- catalogue:start -->

### Layout

#### Page

One screen of the App: a scrolling body with the title row. In a `NavStack` above its first page, the title row starts with a back button. While it is shown (the selected section, the top of its stack) its title is the App's title in the shell; the deepest shown page wins. On iOS the first page of a stack shows a large title that scrolls with the content, and a page above it a navigation bar: back with the title of the page it leads to, the title in the middle, the actions at the end. On Android every page has a top app bar.

| Prop               | Type          | Description                                                                                                                             |
| ------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `title` (required) | `string`      | The page's title, in sentence case.                                                                                                     |
| `description`      | `string`      | One sentence under the title.                                                                                                           |
| `actions`          | `JSX.Element` | Buttons at the end of the title row: at most one primary.                                                                               |
| `children`         | `JSX.Element` | The content.                                                                                                                            |
| `width`            | `PageWidth`   | The widest the content gets: `narrow` 672 points for forms and settings, `default` 1024, `wide` 1280, `full` the pane.                  |
| `gap`              | `Space`       | Space between the page's children; default `xl` (24 points).                                                                            |
| `hideTitle`        | `boolean`     | Hides the title row: for a page whose content starts with its own heading, such as an empty state. Screen readers still read the title. |

#### Section

A titled group of content on a page.

| Prop          | Type          | Description                                              |
| ------------- | ------------- | -------------------------------------------------------- |
| `children`    | `JSX.Element` | The content.                                             |
| `title`       | `string`      | The title, in sentence case.                             |
| `description` | `string`      | One sentence under the title or label.                   |
| `actions`     | `JSX.Element` | Buttons at the end of the title row.                     |
| `gap`         | `Space`       | Space between the header and the children; default `md`. |

#### Stack

Children in a column.

| Prop       | Type          | Description                                       |
| ---------- | ------------- | ------------------------------------------------- |
| `children` | `JSX.Element` | The content.                                      |
| `gap`      | `Space`       | Space between children; default `md` (12 points). |
| `align`    | `Align`       | Cross-axis alignment; default `stretch`.          |
| `justify`  | `Justify`     | Main-axis distribution of the children.           |
| `grow`     | `boolean`     | Takes the space left in its parent.               |

#### Row

Children in a row.

| Prop       | Type          | Description                                                    |
| ---------- | ------------- | -------------------------------------------------------------- |
| `children` | `JSX.Element` | The content.                                                   |
| `gap`      | `Space`       | Space between children; default `sm` (8 points).               |
| `align`    | `Align`       | Cross-axis alignment; default `center`.                        |
| `justify`  | `Justify`     | Main-axis distribution of the children.                        |
| `wrap`     | `boolean`     | Wraps children onto more lines when they do not fit.           |
| `collapse` | `boolean`     | Becomes a column in a compact pane (narrower than 600 points). |
| `grow`     | `boolean`     | Takes the space left in its parent.                            |

#### Grid

Children in equal columns that follow the pane's width.

| Prop             | Type               | Description                                                                                |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `children`       | `JSX.Element`      | The content.                                                                               |
| `columns`        | `1 \| 2 \| 3 \| 4` | Columns in a wide pane. A medium pane shows at most two and a compact pane one. Default 2. |
| `compactColumns` | `1 \| 2`           | Columns in a compact pane; default 1. Two suit small tiles such as `Stat`s.                |
| `gap`            | `Space`            | Default `lg` (16 points).                                                                  |

#### Card

A white sheet that groups related content. Inside an App, cards sit flat on the window body with a hairline, as grouped content does in Desk windows.

| Prop          | Type                             | Description                                                                                                                              |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `children`    | `JSX.Element`                    | The content.                                                                                                                             |
| `title`       | `string`                         | The title, in sentence case.                                                                                                             |
| `description` | `string`                         | One sentence under the title or label.                                                                                                   |
| `actions`     | `JSX.Element`                    | Buttons at the end of the title row.                                                                                                     |
| `padding`     | `'none' \| 'sm' \| 'md' \| 'lg'` | Inner padding: `none`, `sm` 12, `md` 16 (default) or `lg` 24 points.                                                                     |
| `gap`         | `Space`                          | Space between the header and the content's children; default `md`.                                                                       |
| `onPress`     | `() => void`                     | Makes the whole card one button. Give it a `title`: screen readers read the title as the button's name. Do not put other buttons inside. |

#### Divider

A hairline between groups of content.

| Prop       | Type      | Description                             |
| ---------- | --------- | --------------------------------------- |
| `vertical` | `boolean` | A vertical line between items of a row. |

### Navigation

#### AppShell

The frame of an App with top-level sections. It decides the navigation from the App's own pane: a sidebar when the pane is wide, a bottom tab bar on narrow touch screens, a row of tabs at the top in a narrow desktop window. Each section's `content` is usually a `Page` or a `NavStack`. The selected section is the first segment of the App's address (`/<section id>`, then the section's `NavStack` path), so a deep link or a reload opens the same section and the shell can navigate between them.

| Prop                  | Type                    | Description                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `title` (required)    | `string`                | The App's name, shown above the sidebar.                                                 |
| `sections` (required) | `readonly AppSection[]` | Two to six top-level sections.                                                           |
| `value`               | `string`                | The selected section's id, when the App controls it.                                     |
| `defaultValue`        | `string`                | The section shown first, when the App does not control it and the address names none.    |
| `onChange`            | `(id: string) => void`  | Called with the new value as the user changes it.                                        |
| `actions`             | `JSX.Element`           | Buttons at the foot of the sidebar, or at the end of the top tab row: settings, account. |

#### NavStack

Pages pushed on top of each other, with the platform's back gestures and keys. Each page above the first gets a back button in its title row. Only the top page counts as shown: it names the App's title.

| Prop                  | Type                        | Description                                                                                                                         |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stack` (required)    | `NavStackState<R>`          | From `createNavStack`.                                                                                                              |
| `children` (required) | `(route: R) => JSX.Element` | The page of a route: a `Page`, or a page pattern.                                                                                   |
| `routes`              | `NavRoutes<R>`              | Keeps the stack in the App's address (deep links, reloads, the shell's back button). Without it the address names only the section. |

#### Tabs

A segmented control that switches between views of the same content. With `content` on its items it also shows the selected view.

| Prop               | Type                   | Description                                                          |
| ------------------ | ---------------------- | -------------------------------------------------------------------- |
| `label` (required) | `string`               | What the tabs choose between, for screen readers: "Views", "Period". |
| `items` (required) | `readonly TabItem[]`   | The items.                                                           |
| `value`            | `string`               | The selected id, when the App controls it.                           |
| `defaultValue`     | `string`               | The id selected at first, when the App does not control it.          |
| `onChange`         | `(id: string) => void` | Called with the new value as the user changes it.                    |
| `fullWidth`        | `boolean`              | Stretches the tabs across the width, each the same size.             |

### Input

#### Button

A button that runs an action of the App.

| Prop               | Type                   | Description                                                       |
| ------------------ | ---------------------- | ----------------------------------------------------------------- |
| `label` (required) | `string`               | The button's text, in sentence case: a verb for what it does.     |
| `kind`             | `ButtonKind`           | Its emphasis.                                                     |
| `size`             | `ControlSize`          | `sm` 30, `md` 36 (default), `lg` 46 points tall; taller on touch. |
| `icon`             | `IconData`             | An icon before the label.                                         |
| `iconEnd`          | `IconData`             | An icon after the label, such as a chevron for a menu.            |
| `loading`          | `boolean`              | Shows a spinner in place of the label and ignores presses.        |
| `disabled`         | `boolean`              | Turns it off: it shows dimmed and takes no input.                 |
| `fullWidth`        | `boolean`              | Fills the width of its container.                                 |
| `type`             | `'button' \| 'submit'` | `submit` submits the `Form` the button is in.                     |
| `onPress`          | `() => void`           | Called when it is pressed.                                        |

#### IconButton

A square button with an icon only.

| Prop               | Type          | Description                                                                      |
| ------------------ | ------------- | -------------------------------------------------------------------------------- |
| `icon` (required)  | `IconData`    | An icon: one of the `Icon…` constants.                                           |
| `label` (required) | `string`      | What the button does. Screen readers read it, and desktops show it as a tooltip. |
| `kind`             | `ButtonKind`  | Default `subtle`.                                                                |
| `size`             | `ControlSize` | Its size.                                                                        |
| `disabled`         | `boolean`     | Turns it off: it shows dimmed and takes no input.                                |
| `selected`         | `boolean`     | A toggle that is on (a pressed state for screen readers).                        |
| `onPress`          | `() => void`  | Called when it is pressed.                                                       |

#### TextField

A one-line text field with its label.

| Prop               | Type                      | Description                                                                                                                                                                   |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                  | The label above the control, in sentence case. Screen readers read it as the control's name.                                                                                  |
| `description`      | `string`                  | One sentence under the label: what to enter, or what it is for.                                                                                                               |
| `error`            | `string`                  | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.                                                                      |
| `required`         | `boolean`                 | Marks the field as required; a `Form` refuses to submit while it is empty.                                                                                                    |
| `disabled`         | `boolean`                 | Turns it off: it shows dimmed and takes no input.                                                                                                                             |
| `name`             | `string`                  | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`.                                                         |
| `value`            | `string`                  | The text, when the App controls it.                                                                                                                                           |
| `onChange`         | `(value: string) => void` | Called with the new value as the user changes it.                                                                                                                             |
| `onSubmit`         | `(value: string) => void` | Return was pressed.                                                                                                                                                           |
| `placeholder`      | `string`                  | An example of what to enter, never the only instruction.                                                                                                                      |
| `kind`             | `TextFieldKind`           | Its emphasis.                                                                                                                                                                 |
| `icon`             | `IconData`                | An icon at the start of the well.                                                                                                                                             |
| `maxLength`        | `number`                  | The most characters it takes.                                                                                                                                                 |
| `readOnly`         | `boolean`                 | Shows the value for reading and copying, not editing.                                                                                                                         |
| `labelHidden`      | `boolean`                 | Shows no label above the field; screen readers still read it. Only for `kind="search"` at the top of a list, where the magnifier and the placeholder say what the field does. |

#### TextArea

A multi-line text field with its label. It grows with its text.

| Prop               | Type                      | Description                                                                                                           |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                  | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`      | `string`                  | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`            | `string`                  | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`         | `boolean`                 | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`         | `boolean`                 | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`             | `string`                  | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `value`            | `string`                  | The value, when the App controls it.                                                                                  |
| `onChange`         | `(value: string) => void` | Called with the new value as the user changes it.                                                                     |
| `placeholder`      | `string`                  | An example shown while it is empty; never the only instruction.                                                       |
| `rows`             | `3 \| 5 \| 8`             | Lines of text it shows before it grows: 3 (default), 5 or 8.                                                          |
| `maxLength`        | `number`                  | The most characters it takes.                                                                                         |
| `readOnly`         | `boolean`                 | Shows the value for reading and copying, not editing.                                                                 |

#### NumberField

A number with buttons to step it, and its label.

| Prop               | Type                              | Description                                                                                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                          | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`      | `string`                          | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`            | `string`                          | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`         | `boolean`                         | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`         | `boolean`                         | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`             | `string`                          | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `value`            | `number \| null`                  | The number, or `null` while empty.                                                                                    |
| `onChange`         | `(value: number \| null) => void` | Called with the new value as the user changes it.                                                                     |
| `min`              | `number`                          | The smallest value.                                                                                                   |
| `max`              | `number`                          | The largest value.                                                                                                    |
| `step`             | `number`                          | The step of the buttons and arrow keys; default 1.                                                                    |
| `placeholder`      | `string`                          | An example shown while it is empty; never the only instruction.                                                       |
| `unit`             | `string`                          | A unit after the number, such as "kg" or "%".                                                                         |

#### Select

One value chosen from a list: a popup on desktops, a sheet on phones.

| Prop                 | Type                              | Description                                                                                                           |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required)   | `string`                          | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`        | `string`                          | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`              | `string`                          | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`           | `boolean`                         | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`           | `boolean`                         | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`               | `string`                          | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `options` (required) | `readonly SelectOption[]`         | The choices.                                                                                                          |
| `value`              | `string \| null`                  | The chosen option's value, or `null` for none.                                                                        |
| `onChange`           | `(value: string \| null) => void` | Called with the new value as the user changes it.                                                                     |
| `placeholder`        | `string`                          | Shown while nothing is chosen.                                                                                        |
| `searchable`         | `boolean`                         | Adds a search field above long lists.                                                                                 |
| `clearable`          | `boolean`                         | Lets the user go back to no choice.                                                                                   |

#### Combobox

Values chosen from a list filtered by typing.

| Prop                 | Type                                 | Description                                                                                                           |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required)   | `string`                             | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`        | `string`                             | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`              | `string`                             | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`           | `boolean`                            | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`           | `boolean`                            | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`               | `string`                             | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `options` (required) | `readonly SelectOption[]`            | The choices.                                                                                                          |
| `value`              | `readonly string[]`                  | The chosen values; one at most unless `multiple`.                                                                     |
| `onChange`           | `(value: readonly string[]) => void` | Called with the new value as the user changes it.                                                                     |
| `multiple`           | `boolean`                            | Lets the user choose several values.                                                                                  |
| `placeholder`        | `string`                             | An example shown while it is empty; never the only instruction.                                                       |

#### Checkbox

An option that is on or off, set with others on submit.

| Prop               | Type                         | Description                                                                                                           |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                     | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`      | `string`                     | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`            | `string`                     | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `disabled`         | `boolean`                    | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`             | `string`                     | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `checked`          | `boolean`                    | Checked, when the App controls it.                                                                                    |
| `onChange`         | `(checked: boolean) => void` | Called with the new value as the user changes it.                                                                     |
| `indeterminate`    | `boolean`                    | Neither checked nor unchecked: some of the items it stands for are.                                                   |

#### Switch

A setting that takes effect at once when turned on or off.

| Prop               | Type                         | Description                                                                                                                       |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                     | The label above the control, in sentence case. Screen readers read it as the control's name.                                      |
| `description`      | `string`                     | One sentence under the label: what to enter, or what it is for.                                                                   |
| `error`            | `string`                     | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.                          |
| `disabled`         | `boolean`                    | Turns it off: it shows dimmed and takes no input.                                                                                 |
| `name`             | `string`                     | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`.             |
| `checked`          | `boolean`                    |                                                                                                                                   |
| `onChange`         | `(checked: boolean) => void` | Called with the new value as the user changes it.                                                                                 |
| `labelHidden`      | `boolean`                    | Shows the switch alone, as a `ListItem`'s control whose title already says what it turns on. Screen readers still read the label. |

#### RadioGroup

Exactly one of a few options, all visible at once.

| Prop                 | Type                      | Description                                                                                                           |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required)   | `string`                  | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`        | `string`                  | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`              | `string`                  | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`           | `boolean`                 | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`           | `boolean`                 | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`               | `string`                  | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `options` (required) | `readonly RadioOption[]`  | The choices.                                                                                                          |
| `value`              | `string \| null`          | The chosen value, when the App controls it.                                                                           |
| `onChange`           | `(value: string) => void` | Called with the new value as the user changes it.                                                                     |
| `direction`          | `'column' \| 'row'`       | `row` lays short options side by side; default `column`.                                                              |

#### Slider

A number picked along a track, for values where the exact number matters less than the position: volume, brightness, a target.

| Prop               | Type                        | Description                                                                                                           |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                    | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`      | `string`                    | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`            | `string`                    | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `disabled`         | `boolean`                   | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`             | `string`                    | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `value`            | `number`                    | The value, when the App controls it.                                                                                  |
| `onChange`         | `(value: number) => void`   | Called with the new value as the user changes it.                                                                     |
| `min`              | `number`                    | The smallest value.                                                                                                   |
| `max`              | `number`                    | The largest value.                                                                                                    |
| `step`             | `number`                    |                                                                                                                       |
| `formatValue`      | `(value: number) => string` | Writes the value beside the label: `(value) => \`${value} %\``.                                                       |

#### DatePicker

A date, or a date and time, picked from a calendar: a popup on desktops, a sheet on phones.

| Prop               | Type                              | Description                                                                                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`                          | The label above the control, in sentence case. Screen readers read it as the control's name.                          |
| `description`      | `string`                          | One sentence under the label: what to enter, or what it is for.                                                       |
| `error`            | `string`                          | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.              |
| `required`         | `boolean`                         | Marks the field as required; a `Form` refuses to submit while it is empty.                                            |
| `disabled`         | `boolean`                         | Turns it off: it shows dimmed and takes no input.                                                                     |
| `name`             | `string`                          | The key of the value in its `Form`: the form keeps the value, restores it from the draft and passes it to `onSubmit`. |
| `value`            | `string \| null`                  | The date as ISO 8601: `2026-04-12`, or `2026-04-12T09:30` with `withTime`; `null` for none.                           |
| `onChange`         | `(value: string \| null) => void` | Called with the new value as the user changes it.                                                                     |
| `withTime`         | `boolean`                         | Also picks a time of day.                                                                                             |
| `placeholder`      | `string`                          | An example shown while it is empty; never the only instruction.                                                       |
| `clearable`        | `boolean`                         | Lets the user go back to no date.                                                                                     |

#### Form

A form: keeps its named fields' values, saves them as a draft while the user types, checks required fields and submits.

| Prop                  | Type                                                          | Description                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (required)       | `string`                                                      | Names the form's draft: unique in the App and stable across releases, such as `"new-expense"` or `"edit-note"`.                                                                                   |
| `onSubmit` (required) | `(values: FormValues) => unknown`                             | Runs when the form is submitted and every required field has a value. A promise keeps submit buttons busy; a rejection shows its message above the fields. The draft is deleted once it resolves. |
| `initialValues`       | `FormValues`                                                  | Values the fields start with, by `name`.                                                                                                                                                          |
| `validate`            | `(values: FormValues) => Record<string, string> \| undefined` | Extra checks on submit: an error message by field `name`, or nothing.                                                                                                                             |
| `saveDraft`           | `boolean`                                                     | Keeps unsent input on the device so it survives the shell stopping a hidden App. Default true. Password fields are never kept.                                                                    |
| `disabled`            | `boolean`                                                     | Turns every field and submit button off.                                                                                                                                                          |
| `gap`                 | `Space`                                                       | Space between the fields; default `lg` (16 points).                                                                                                                                               |
| `children`            | `JSX.Element`                                                 | Fields with a `name`, and a `Button` with `type="submit"`.                                                                                                                                        |

#### Field

A form control's label, description and error around the control.

| Prop               | Type          | Description                                                                                                                                   |
| ------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `label` (required) | `string`      | The label above the control, in sentence case. Screen readers read it as the control's name.                                                  |
| `description`      | `string`      | One sentence under the label: what to enter, or what it is for.                                                                               |
| `error`            | `string`      | An error under the control. Inside a `Form`, the form's errors for the field's `name` show here as well.                                      |
| `required`         | `boolean`     | Marks the field as required; a `Form` refuses to submit while it is empty.                                                                    |
| `children`         | `JSX.Element` | The control.                                                                                                                                  |
| `labelHidden`      | `boolean`     | Leaves the label to screen readers (the control names itself with it): only for a search field whose icon and placeholder say what it is for. |

### Display

#### Text

Body text.

| Prop         | Type                              | Description                                                           |
| ------------ | --------------------------------- | --------------------------------------------------------------------- |
| `children`   | `JSX.Element`                     | The text. Nested `Text` elements are spans of the same paragraph.     |
| `size`       | `'sm' \| 'md' \| 'lg'`            | `sm` caption (12), `md` body (14, default), `lg` lead paragraph (16). |
| `weight`     | `'regular' \| 'strong' \| 'bold'` | `regular` (500, default), `strong` (600) or `bold` (700).             |
| `tone`       | `TextTone`                        | Ink by default; `muted` for secondary text.                           |
| `align`      | `'start' \| 'center' \| 'end'`    |                                                                       |
| `lines`      | `1 \| 2 \| 3 \| 4`                | Cuts the text to this many lines with an ellipsis.                    |
| `mono`       | `boolean`                         | JetBrains Mono, for identifiers, codes and values people copy.        |
| `selectable` | `boolean`                         | Lets people select and copy the text. Only for content they copy.     |

#### Heading

A heading, announced as one by screen readers.

| Prop       | Type                           | Description                                                                    |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `children` | `JSX.Element`                  | The heading's text.                                                            |
| `level`    | `1 \| 2 \| 3 \| 4`             | 1 display (30), 2 page title (24, default), 3 section (20), 4 subsection (17). |
| `tone`     | `'default' \| 'muted'`         | What its colour means.                                                         |
| `align`    | `'start' \| 'center' \| 'end'` |                                                                                |
| `lines`    | `1 \| 2`                       |                                                                                |

#### Badge

A short label for a status or a count (DESIGN.md "Status chip"). On Android it is Material's outlined chip, the tone in its text and dot.

| Prop               | Type      | Description                                           |
| ------------------ | --------- | ----------------------------------------------------- |
| `label` (required) | `string`  | One or two words in sentence case: "Active", "3 due". |
| `tone`             | `Tone`    | Default `neutral`. Keep ordinary metadata neutral.    |
| `dot`              | `boolean` | A dot before the label, for a status.                 |

#### Avatar

A person's picture, or a monogram on a colour chosen from their name.

| Prop              | Type                 | Description                                                                                        |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `name` (required) | `string`             | The person's or the thing's name: its first letter is the monogram, and screen readers read it.    |
| `src`             | `string`             | An image URL; the monogram shows while it loads and when it fails.                                 |
| `colorKey`        | `string`             | Picks the monogram colour; default the name. Pass an id so the colour stays when the name changes. |
| `size`            | `AvatarSize`         | `sm` 24, `md` 32 (default), `lg` 40, `xl` 56 points.                                               |
| `shape`           | `'circle' \| 'tile'` | `circle` for people (default), `tile` for things such as a project.                                |

#### List

Rows of related items on one sheet, divided by hairlines.

| Prop         | Type                             | Description                                                                                        |
| ------------ | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `title`      | `string`                         | A short label above the list, written in sentence case; it shows as a small uppercase group label. |
| `items`      | `readonly T[]`                   | The items, with `renderItem`; or pass `ListItem`s as children.                                     |
| `renderItem` | `(item: () => T) => JSX.Element` | One `ListItem` per item; `item()` follows the row.                                                 |
| `getKey`     | `(item: T) => string`            | Keeps rows by an id of each item; default the item itself.                                         |
| `children`   | `JSX.Element`                    | Rows as children, when there is no `items`.                                                        |
| `empty`      | `string`                         | The line shown when `items` is empty.                                                              |
| `loading`    | `boolean`                        | Shows placeholder rows while the items load.                                                       |

#### ListItem

One row of a `List` (DESIGN.md "List row").

| Prop               | Type                             | Description                                                                                         |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `title` (required) | `string`                         | The title, in sentence case.                                                                        |
| `description`      | `string`                         | One meta line under the title.                                                                      |
| `icon`             | `IconData`                       | A 34-point tile with this icon at the start.                                                        |
| `avatar`           | `{ name: string; src?: string }` | An avatar at the start, for people.                                                                 |
| `value`            | `string`                         | A value at the end: "6 plants", "Tomorrow".                                                         |
| `badge`            | `BadgeProps`                     | A status chip at the end.                                                                           |
| `control`          | `JSX.Element`                    | A control at the end, such as a `Switch` without its own label row.                                 |
| `onPress`          | `() => void`                     | Makes the row open something; it gets a chevron.                                                    |
| `selected`         | `boolean`                        | The current item of a navigation list.                                                              |
| `disabled`         | `boolean`                        | Turns it off: it shows dimmed and takes no input.                                                   |
| `actions`          | `readonly Action[]`              | Icon actions at the end: shown on hover and keyboard focus with a pointer, always on touch screens. |

#### DataTable

Rows of records in columns, for data people compare and sort. It scrolls sideways in narrow panes and down past `visibleRows`.

| Prop                 | Type                            | Description                                                |
| -------------------- | ------------------------------- | ---------------------------------------------------------- |
| `label` (required)   | `string`                        | What the table lists, for screen readers: "Expenses".      |
| `columns` (required) | `readonly DataTableColumn<T>[]` |                                                            |
| `rows` (required)    | `readonly T[]`                  |                                                            |
| `onRowPress`         | `(row: T) => void`              | A row was pressed: open it.                                |
| `visibleRows`        | `5 \| 10 \| 15 \| 20`           | Rows the table shows before it scrolls; default 10.        |
| `loading`            | `boolean`                       | Shows a spinner in place of rows that have not loaded yet. |
| `empty`              | `string`                        | One line shown when there are no rows.                     |

#### Stat

A key figure with its label and change.

| Prop               | Type                       | Description                                             |
| ------------------ | -------------------------- | ------------------------------------------------------- |
| `label` (required) | `string`                   | What is measured: "Harvested this month".               |
| `value` (required) | `string`                   | The figure, formatted: "12.4 kg", "86 %".               |
| `change`           | `string`                   | The change against a comparison, formatted: "+8 %".     |
| `trend`            | `'up' \| 'down' \| 'flat'` | Whether the change is up, down or flat.                 |
| `upIsGood`         | `boolean`                  | Whether up is good (default) or bad, such as for costs. |
| `comparison`       | `string`                   | What the change compares with: "vs last month".         |
| `icon`             | `IconData`                 | An icon: one of the `Icon…` constants.                  |

#### Progress

How far a task has come.

| Prop               | Type                                             | Description                                                                         |
| ------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `label` (required) | `string`                                         | What is in progress, for screen readers and shown above the bar.                    |
| `value`            | `number`                                         | From 0 to 100.                                                                      |
| `indeterminate`    | `boolean`                                        | Work whose end is not known: the bar moves without a value.                         |
| `showValue`        | `boolean`                                        | Writes the value beside the label; default the percentage. Pass `false` to hide it. |
| `tone`             | `'accent' \| 'success' \| 'warning' \| 'danger'` | What its colour means.                                                              |

#### EmptyState

What a page or a list shows while it has nothing to show.

| Prop               | Type                    | Description                                                                              |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| `title` (required) | `string`                | What would be here: "No harvests yet".                                                   |
| `description`      | `string`                | One or two sentences: why it is empty and what to do.                                    |
| `icon`             | `IconData`              | An icon: one of the `Icon…` constants.                                                   |
| `action`           | `Action`                | The way forward: at most one, shown as the primary button.                               |
| `secondaryAction`  | `Action`                | A second, quieter way forward.                                                           |
| `tone`             | `'neutral' \| 'accent'` | `accent` tints the icon tile; default `neutral`.                                         |
| `compact`          | `boolean`               | One muted line in place of a list's rows, for an empty list or a search without results. |

#### Skeleton

A placeholder in the shape of content that is loading.

| Prop    | Type                            | Description                                                                                    |
| ------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `shape` | `'text' \| 'circle' \| 'block'` | `text` lines (default), a `circle` such as an avatar, or a `block` such as an image or a card. |
| `lines` | `1 \| 2 \| 3 \| 4 \| 5`         | Lines of text; default 3. The last is shorter.                                                 |

#### Icon

An icon from the `@hatch/ui` set, drawn natively.

| Prop              | Type       | Description                                                                                                    |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `icon` (required) | `IconData` | The icon: one of the `Icon…` constants exported by `@hatch/ui`.                                                |
| `size`            | `IconSize` | 12 (`xs`) to 26 (`2xl`) points; default `md` (16).                                                             |
| `tone`            | `IconTone` | Default ink. A tone never carries meaning alone: pair it with text.                                            |
| `label`           | `string`   | Makes the icon an image a screen reader announces. Leave it out when text beside the icon says the same thing. |

### Feedback

#### Dialog

A modal window over the App for a short task: a centred window on desktops, a sheet from the bottom on phones.

| Prop                      | Type                      | Description                                                                                              |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `open` (required)         | `boolean`                 | Shown while true.                                                                                        |
| `onOpenChange` (required) | `(open: boolean) => void` | The user closed it (Escape, the backdrop, a swipe, the close button), or it opened. Set `open` to match. |
| `title` (required)        | `string`                  | The title, which screen readers read as its name.                                                        |
| `description`             | `string`                  | One or two sentences under the title.                                                                    |
| `children`                | `JSX.Element`             | The content.                                                                                             |
| `actions`                 | `JSX.Element`             | Buttons at the bottom: the main action last, at most one primary.                                        |
| `size`                    | `'sm' \| 'md' \| 'lg'`    | Its width on desktops: `sm` 384, `md` 512 (default), `lg` 672 points.                                    |

#### Sheet

A panel for a longer side task: from the bottom on touch screens and in compact panes, from the end edge on desktops.

| Prop                      | Type                      | Description                                                                                              |
| ------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `open` (required)         | `boolean`                 | Shown while true.                                                                                        |
| `onOpenChange` (required) | `(open: boolean) => void` | The user closed it (Escape, the backdrop, a swipe, the close button), or it opened. Set `open` to match. |
| `title` (required)        | `string`                  | The title, which screen readers read as its name.                                                        |
| `description`             | `string`                  | One or two sentences under the title.                                                                    |
| `children`                | `JSX.Element`             | The content.                                                                                             |
| `actions`                 | `JSX.Element`             | Buttons at the bottom: the main action last, at most one primary.                                        |

#### AlertDialog

Asks the user to confirm before an action that cannot be undone. Do not ask for actions that can be undone: do them, and offer Undo in a `Toast`.

| Member    | Type                                                                                                                                                                                                             | Description                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `confirm` | `confirm(options: { title: string; description?: string; /** The action, as a verb: "Delete", "Leave". */ confirmLabel: string; cancelLabel?: string; /** Draws the action in red. */ destructive?: boolean; })` | Resolves to true when the user confirms.                 |
| `alert`   | `alert(options: { title: string; description?: string; buttonLabel?: string; })`                                                                                                                                 | Tells the user something they must read before going on. |

#### Toast

Short messages over the App that go away on their own: "Saved", "Could not send · Try again". Call from anywhere after `mount`.

| Member    | Type                                           | Description                            |
| --------- | ---------------------------------------------- | -------------------------------------- |
| `show`    | `show(options: ToastOptions)`                  | Shows a toast; returns its id.         |
| `success` | `success(title: string, description?: string)` | Shows a success toast.                 |
| `error`   | `error(title: string, description?: string)`   | Shows a toast for a failure.           |
| `dismiss` | `dismiss(id: string)`                          | Removes a toast before its time is up. |

#### Tooltip

A hint shown while the pointer rests on its element, on desktops. Touch screens have no hover, so never put information only in a tooltip.

| Prop               | Type          | Description                                                     |
| ------------------ | ------------- | --------------------------------------------------------------- |
| `label` (required) | `string`      | A short hint, one line: what the element does or what it shows. |
| `children`         | `JSX.Element` | The element the hint is about.                                  |

#### Menu

Actions behind a button: a popup on desktops, a sheet on phones. Use it for secondary actions; keep the main action of a view on a visible button.

| Prop               | Type                   | Description                                                                            |
| ------------------ | ---------------------- | -------------------------------------------------------------------------------------- |
| `label` (required) | `string`               | What the menu holds, as the trigger's name: "More actions", "Sort".                    |
| `items` (required) | `readonly MenuEntry[]` | The items.                                                                             |
| `trigger`          | `'icon' \| 'button'`   | `icon` (default) shows an icon button; `button` a button with the label and a chevron. |
| `icon`             | `IconData`             | The trigger's icon; default three dots.                                                |

### Page patterns

#### ListDetailPage

A list of records and the detail of the chosen one: side by side in a wide pane, one after the other with a back button in a narrow one.

| Prop                      | Type                                                                         | Description                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title` (required)        | `string`                                                                     | The title, in sentence case.                                                                                                                                                                                    |
| `description`             | `string`                                                                     | One sentence under the title or label.                                                                                                                                                                          |
| `actions`                 | `JSX.Element`                                                                | Buttons at the end of the title row, such as Add.                                                                                                                                                               |
| `items` (required)        | `readonly T[]`                                                               | The items.                                                                                                                                                                                                      |
| `getKey` (required)       | `(item: T) => string`                                                        | A stable id of an item.                                                                                                                                                                                         |
| `renderItem` (required)   | `(item: T) => Omit<ListItemProps, 'onPress' \| 'selected'>`                  | How an item reads in the list.                                                                                                                                                                                  |
| `detailTitle` (required)  | `(item: T) => string`                                                        | The title of the detail of an item.                                                                                                                                                                             |
| `renderDetail` (required) | `(item: () => T) => JSX.Element`                                             | The detail of the selected item: the content of its page. Called once per selected item; `item()` follows the record when the App replaces it with a newer one of the same key, so input in the detail is kept. |
| `selectedKey`             | `string \| null`                                                             | The selected item's id, when the App controls it.                                                                                                                                                               |
| `onSelect`                | `(key: string \| null) => void`                                              |                                                                                                                                                                                                                 |
| `search`                  | `{ value: string; onChange: (value: string) => void; placeholder?: string }` | A search field above the list, labelled by its placeholder (default "Search <title>"). Filtering is the App's.                                                                                                  |
| `empty`                   | `EmptyStateProps`                                                            | What shows when there are no items.                                                                                                                                                                             |
| `loading`                 | `boolean`                                                                    |                                                                                                                                                                                                                 |

#### FormPage

A page that is one form: creating or editing one record.

| Prop                     | Type                                                          | Description                                                           |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `title` (required)       | `string`                                                      | The title, in sentence case.                                          |
| `description`            | `string`                                                      | One sentence under the title or label.                                |
| `formId` (required)      | `string`                                                      | The form's id, which names its draft (see `Form`).                    |
| `onSubmit` (required)    | `(values: FormValues) => unknown`                             | Runs on submit with the fields' values, as `Form`'s `onSubmit`.       |
| `initialValues`          | `FormValues`                                                  | Values the fields start with, by `name`.                              |
| `validate`               | `(values: FormValues) => Record<string, string> \| undefined` | Extra checks on submit: an error message by field `name`, or nothing. |
| `submitLabel` (required) | `string`                                                      | The submit button's label: a verb for the result, "Add plant".        |
| `onCancel`               | `() => void`                                                  | A way out without saving.                                             |
| `children`               | `JSX.Element`                                                 | Named fields. Group long forms with `Section`s.                       |

#### SettingsPage

A page of preferences, grouped and narrow enough to scan.

| Prop               | Type          | Description                                                          |
| ------------------ | ------------- | -------------------------------------------------------------------- |
| `title` (required) | `string`      | The title, in sentence case.                                         |
| `description`      | `string`      | One sentence under the title or label.                               |
| `children`         | `JSX.Element` | `Section`s of `List`s whose rows carry `Switch`es, values and links. |

#### DashboardPage

An overview: key figures, then cards of detail.

| Prop               | Type                   | Description                                             |
| ------------------ | ---------------------- | ------------------------------------------------------- |
| `title` (required) | `string`               | The title, in sentence case.                            |
| `description`      | `string`               | One sentence under the title or label.                  |
| `actions`          | `JSX.Element`          |                                                         |
| `stats`            | `readonly StatProps[]` | Key figures in a row at the top: two to four read best. |
| `children`         | `JSX.Element`          | Cards below the figures, in columns.                    |
| `columns`          | `1 \| 2 \| 3`          | Columns of the cards in a wide pane; default 2.         |

### State and start-up

#### mount

Starts the App: renders `app` into the shell, follows the shell's theme, keeps the shell's title on the shown page's and hosts toasts. Call it once, in `app/main.tsx`.

`mount(app: Component): () => void`

#### signal

A value that components follow: `const count = signal(0)`; read `count()`, write `count.set(1)` or `count.update((n) => n + 1)`.

#### memo

A value derived from signals, computed again when they change: `const total = memo(() => items().length)`.

#### effect

Runs after rendering and again when the signals it reads change; a returned function cleans up.

#### resource

Loads a value asynchronously: `const notes = resource(() => client.listNotes({}))`, or `resource(source, (value) => …)` to load again when the `source` accessor changes. Read `notes()` (undefined until loaded); `notes.loading()`, `notes.error()`, `notes.state()`, `notes.refetch()` and `notes.mutate(value)` control it.

#### If

Renders its children while `when` is truthy, else `else`.

| Prop              | Type                                                            | Description                                                                                                                         |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `when` (required) | `T`                                                             | Shows the children while this is truthy.                                                                                            |
| `else`            | `JSX.Element`                                                   | Shown while `when` is falsy.                                                                                                        |
| `children`        | `JSX.Element \| ((value: () => NonNullable<T>) => JSX.Element)` | The content, or a function of an accessor of `when`'s value, written with that parameter: `{(user) => <Text>{user().name}</Text>}`. |

#### Each

Renders one row per item of `of`, kept by `key`.

| Prop                  | Type                                                  | Description                                                                                                 |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `of` (required)       | `readonly T[] \| null \| undefined`                   | The items.                                                                                                  |
| `key`                 | `'index' \| ((item: T, index: number) => unknown)`    | How rows are kept: by a key of each item (default: the item itself), or `"index"` to keep rows by position. |
| `children` (required) | `(item: () => T, index: () => number) => JSX.Element` | One row per item; `item()` and `index()` follow the row.                                                    |

#### createNavStack

The state of a `NavStack`: its routes, with `push`, `pop`, `popToRoot`, `replace` and `setRoutes`. Make it once, outside components, with the first route: `const nav = createNavStack<Route>([{ name: 'list' }])`.

`createNavStack(routes: R[]): NavStackState<R>`

### Shared types

#### Action

An action shown as a button: in an empty state, a menu, a row.

| Field                | Type         | Description                                                       |
| -------------------- | ------------ | ----------------------------------------------------------------- |
| `label` (required)   | `string`     | What it is, in sentence case; screen readers read it as its name. |
| `onPress` (required) | `() => void` | Called when it is pressed.                                        |
| `icon`               | `IconData`   | An icon: one of the `Icon…` constants.                            |
| `disabled`           | `boolean`    | Turns it off: it shows dimmed and takes no input.                 |

#### AppSection

One top-level section of the App.

| Field                | Type                | Description                                                       |
| -------------------- | ------------------- | ----------------------------------------------------------------- |
| `id` (required)      | `string`            | Stable id: the value `onChange` reports.                          |
| `label` (required)   | `string`            | What it is, in sentence case; screen readers read it as its name. |
| `icon` (required)    | `IconData`          | Sections show an icon in every layout.                            |
| `badge`              | `string`            | A short count or word beside the label, such as unread items.     |
| `disabled`           | `boolean`           | Turns it off: it shows dimmed and takes no input.                 |
| `content` (required) | `() => JSX.Element` |                                                                   |

#### TabItem

One tab of `Tabs` or one section of `AppShell`.

| Field              | Type                | Description                                                                                                            |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id` (required)    | `string`            | Stable id: the value `onChange` reports.                                                                               |
| `label` (required) | `string`            | What it is, in sentence case; screen readers read it as its name.                                                      |
| `icon`             | `IconData`          | An icon: one of the `Icon…` constants.                                                                                 |
| `badge`            | `string`            | A short count or word beside the label, such as unread items.                                                          |
| `disabled`         | `boolean`           | Turns it off: it shows dimmed and takes no input.                                                                      |
| `content`          | `() => JSX.Element` | What the tab shows. A visited tab stays mounted while hidden, so its scroll position and input survive switching back. |

#### SelectOption

One choice of a `Select` or `Combobox`.

| Field              | Type      | Description                                                       |
| ------------------ | --------- | ----------------------------------------------------------------- |
| `value` (required) | `string`  | The value, when the App controls it.                              |
| `label` (required) | `string`  | What it is, in sentence case; screen readers read it as its name. |
| `disabled`         | `boolean` | Turns it off: it shows dimmed and takes no input.                 |
| `group`            | `string`  | Options with the same group are listed under it.                  |

#### RadioOption

One option of a `RadioGroup`.

| Field              | Type      | Description                                                       |
| ------------------ | --------- | ----------------------------------------------------------------- |
| `value` (required) | `string`  | The value, when the App controls it.                              |
| `label` (required) | `string`  | What it is, in sentence case; screen readers read it as its name. |
| `description`      | `string`  | One sentence under the title or label.                            |
| `disabled`         | `boolean` | Turns it off: it shows dimmed and takes no input.                 |

#### MenuEntry

One entry of a `Menu`. Or `'separator'`.

| Field                 | Type         | Description                                                       |
| --------------------- | ------------ | ----------------------------------------------------------------- |
| `label` (required)    | `string`     | What it is, in sentence case; screen readers read it as its name. |
| `onSelect` (required) | `() => void` |                                                                   |
| `icon`                | `IconData`   | An icon: one of the `Icon…` constants.                            |
| `destructive`         | `boolean`    | Draws the item in red: for deleting and leaving.                  |
| `disabled`            | `boolean`    | Turns it off: it shows dimmed and takes no input.                 |
| `checked`             | `boolean`    | A check mark: the item is an option that is on.                   |

#### DataTableColumn

| Field              | Type                                             | Description                                                     |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| `key` (required)   | `keyof T & string`                               | The row field the column shows.                                 |
| `title` (required) | `string`                                         | The title, in sentence case.                                    |
| `width`            | `keyof typeof COLUMN_WIDTH`                      | `xs` 72 to `xl` 320 points; default fits the content.           |
| `align`            | `'start' \| 'center' \| 'end'`                   | `end` for numbers and amounts.                                  |
| `sortable`         | `boolean`                                        | Lets the user sort by this column.                              |
| `format`           | `(value: T[keyof T & string], row: T) => string` | Turns a field into the text shown, such as a date or an amount. |
| `fixed`            | `boolean`                                        | Keeps the column in place while the others scroll sideways.     |

#### ToastOptions

| Field              | Type        | Description                                                     |
| ------------------ | ----------- | --------------------------------------------------------------- |
| `title` (required) | `string`    | A short sentence: what happened.                                |
| `description`      | `string`    | More detail, one sentence.                                      |
| `tone`             | `ToastTone` | What its colour means.                                          |
| `action`           | `Action`    | One action, such as Undo. Pressing it also dismisses the toast. |
| `duration`         | `number`    | Seconds the toast stays; default 5, 8 with an action.           |

### Icons

Pass an icon constant: `<Icon icon={IconLeaf} />`, `<Button icon={IconPlus} … />`. There are 189; a bundle keeps only those it imports.

- Actions: `IconPlus`, `IconMinus`, `IconX`, `IconCheck`, `IconPencil`, `IconTrash`, `IconCopy`, `IconClipboard`, `IconShare`, `IconDownload`, `IconUpload`, `IconSend`, `IconRefresh`, `IconRotate`, `IconSearch`, `IconFilter`, `IconAdjustmentsHorizontal`, `IconSortAscending`, `IconSortDescending`, `IconDots`, `IconDotsVertical`, `IconExternalLink`, `IconLink`, `IconPaperclip`, `IconPrinter`, `IconZoomIn`, `IconZoomOut`, `IconMaximize`, `IconMinimize`, `IconLogout`, `IconLogin`, `IconGripVertical`
- Navigation: `IconChevronLeft`, `IconChevronRight`, `IconChevronUp`, `IconChevronDown`, `IconSelector`, `IconArrowLeft`, `IconArrowRight`, `IconArrowUp`, `IconArrowDown`, `IconArrowUpRight`, `IconMenu2`, `IconHome`, `IconHome2`, `IconLayoutSidebar`, `IconLayoutGrid`, `IconList`, `IconTable`, `IconDashboard`, `IconTypography`, `IconSettings`
- Status: `IconCircleCheck`, `IconCircleX`, `IconAlertTriangle`, `IconAlertCircle`, `IconInfoCircle`, `IconHelpCircle`, `IconCirclePlus`, `IconSquareCheck`, `IconEye`, `IconEyeOff`, `IconLock`, `IconLockOpen`, `IconKey`, `IconShield`, `IconBell`, `IconFlag`, `IconPin`, `IconStar`, `IconHeart`, `IconBookmark`, `IconBolt`, `IconSparkles`
- Objects: `IconUser`, `IconUsers`, `IconUserPlus`, `IconCalendar`, `IconCalendarEvent`, `IconClock`, `IconAlarm`, `IconHourglass`, `IconHistory`, `IconMail`, `IconInbox`, `IconArchive`, `IconMessage`, `IconMessages`, `IconPhone`, `IconAt`, `IconHash`, `IconTag`, `IconFolder`, `IconFile`, `IconFileText`, `IconNotebook`, `IconNotes`, `IconBook`, `IconNews`, `IconRss`, `IconChecklist`, `IconListCheck`, `IconPhoto`, `IconCamera`, `IconMusic`, `IconVideo`, `IconMicrophone`, `IconVolume`, `IconPlayerPlay`, `IconPlayerPause`, `IconPlayerStop`, `IconRepeat`, `IconMap`, `IconMapPin`, `IconWorld`, `IconWifi`, `IconDeviceMobile`, `IconDeviceDesktop`, `IconCode`, `IconTerminal`, `IconDatabase`, `IconServer`, `IconRobot`, `IconWand`, `IconBulb`, `IconPalette`, `IconBrush`, `IconTool`, `IconHammer`, `IconBox`, `IconPackage`, `IconStack2`, `IconLayersSubtract`, `IconQrcode`, `IconSpeakerphone`, `IconTicket`, `IconTarget`, `IconAward`, `IconTrophy`, `IconConfetti`, `IconGift`
- Money and shopping: `IconCurrencyDollar`, `IconCash`, `IconWallet`, `IconCreditCard`, `IconReceipt`, `IconPercentage`, `IconShoppingCart`, `IconBasket`, `IconBuildingStore`, `IconTruck`, `IconScale`
- Charts: `IconChartBar`, `IconChartLine`, `IconChartPie`, `IconTrendingUp`, `IconTrendingDown`
- Life and nature: `IconSun`, `IconMoon`, `IconCloud`, `IconCloudRain`, `IconSnowflake`, `IconTemperature`, `IconUmbrella`, `IconDroplet`, `IconFlame`, `IconPlant`, `IconLeaf`, `IconTree`, `IconMountain`, `IconBeach`, `IconCoffee`, `IconGlass`, `IconSalad`, `IconBread`, `IconCake`, `IconRun`, `IconBarbell`, `IconBed`, `IconHeartbeat`, `IconPill`, `IconPaw`, `IconDog`, `IconCat`, `IconCar`, `IconPlane`, `IconBriefcase`, `IconSchool`, `IconMoodSmile`

<!-- catalogue:end -->
