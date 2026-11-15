# Frontend and widgets

Read this reference when an App has a frontend or dashboard widget.

## React SPA

The platform serves `app/index.html`, which loads the bundled `./app.js`.
Use TanStack Router with hash history because the App is served inside a static
iframe. Keep every user-navigable route represented in the source manifest (`manifest.ts` or `manifest.json`) under
`app.routes`; this metadata powers entry-point discovery but does not register
routes at runtime.

Use TanStack Query for RPC/server state. Do not fetch with `useEffect` plus
`useState`. Use Zod for runtime response validation when the server response
needs an additional trust boundary.

The generated Connect client uses the injected `__RPC_BASE_URL__`:

```tsx
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { useQuery } from '@tanstack/react-query';
import { TodoService } from '../gen/service_pb.ts';

declare const __RPC_BASE_URL__: string;

const client = createClient(
  TodoService,
  createConnectTransport({ baseUrl: __RPC_BASE_URL__ }),
);

export function useTodos() {
  return useQuery({
    queryKey: ['todos'],
    queryFn: () => client.list({}),
  });
}
```

Adapt the scaffolded router and Query client rather than replacing their
platform wiring. Import packages normally after adding them to `package.json`.

## Browser storage

Every App page and widget runs on the Hatch origin. Before any App code runs,
Hatch scopes that page's `localStorage` and `sessionStorage` to the App: keys,
`length`, `clear()` and `storage` events cover only this App's entries, so
Apps and Hatch cannot overwrite or clear each other's values. Use the standard
API and libraries built on it (such as Mantine `useLocalStorage` or Zustand
`persist`) normally. The page and its widgets share the App's entries.

`@hatch/app/storage` adds listing and change notifications that also report
changes made in the same page:

```tsx
import { createAppStorage } from '@hatch/app/storage';
import { useAppStorageItem } from '@hatch/app/storage/react';

const storage = createAppStorage(); // { area: 'session' } for sessionStorage

function ThemeToggle() {
  const [theme, setTheme] = useAppStorageItem(storage, 'theme');
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme ?? 'light'}
    </button>
  );
}
```

The object reads and writes the same entries as `localStorage` and has the
same methods, plus `keys()`, `entries()`, and `watch(listener)` or
`watch(key, listener)`, which report `{ key, oldValue, newValue }` for
changes from this page, other tabs, and the App's widgets and return an
unsubscribe function. `useAppStorageItem(storage, key)` returns
`[value, setValue]`; `setValue(null)` removes the key.

Values are strings; `JSON.stringify` structured data and validate it with Zod
when read. Entries survive deployments and slug changes but live in one
browser profile: they are not synchronized across devices or users, and the
origin's quota (about 5 MB) is shared with other Apps. Keep only small UI
preferences and drafts here; store user data with Data Tables, KV, or the
backend. The scope prevents collisions, not snooping, so never store secrets
in browser storage.

## Widgets

Each widget is a standalone bundle and must export `mount(element, context)`
and return an unmount function:

```tsx
import { createRoot } from 'react-dom/client';

type WidgetSize = { w: number; h: number; width: number; height: number };
type WidgetContext = {
  size: WidgetSize;
  onResize: (callback: (size: WidgetSize) => void) => () => void;
  onRefresh: (callback: () => void | Promise<unknown>) => () => void;
};

export function mount(
  element: HTMLElement,
  context?: WidgetContext,
): () => void {
  const root = createRoot(element);
  root.render(<Widget context={context} />);
  return () => root.unmount();
}
```

Set `defaultSize` to an integer `w`/`h` footprint from 1 through 12. Build a
responsive widget by default and omit `supportedSizes`; use `context.size` and
`context.onResize` to adapt to grid and pixel dimensions. Declare
`supportedSizes` only after implementing and verifying every listed footprint.

Register `context.onRefresh` only when the widget performs real refresh work.
Return the actual refresh Promise so the dashboard spinner tracks completion.
For TanStack Query, return `invalidateQueries`/`refetchQueries`; use
`Promise.all` for multiple independent queries.

Treat initial load and background refresh differently:

- Before any successful data, show a loading state; an error may replace it
  with an error plus Retry action.
- After data has loaded, keep it visible throughout refresh. Replace it only
  after a successful request.
- On refresh failure, retain the previous data and use a non-destructive error
  indicator.
- Do not add a routine refresh button inside the widget; the dashboard provides
  it when `onRefresh` is registered.

Widgets may use the same Connect client or managed Data Table client as the SPA.
