import { MantineProvider } from '@mantine/core';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { NATIVE_APP_EVENT } from '~components/desktop-host/native-apps';
import { AppSurface, type AppSurfaceHandle } from './app-surface';

// The macOS app announces itself in the user agent and grants the page its
// native App commands over Tauri's IPC; here a fake stands in for both.
type Invoke = (command: string, args?: Record<string, unknown>) => unknown;
const invoke = vi.fn<Invoke>();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 HatchDesktop/0.1.0',
  );
  invoke.mockReset();
  invoke.mockImplementation(async (command) =>
    command === 'native_app_snapshot' ? PNG.buffer : null,
  );
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    { invoke };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  document.querySelectorAll('[data-portal]').forEach((node) => node.remove());
});

function calls(command: string) {
  return invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

function emit(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(NATIVE_APP_EVENT, { detail }));
}

async function renderNative(route = '/notes') {
  const handle = createRef<AppSurfaceHandle>();
  const onRouteChange = vi.fn<(route: string) => void>();
  const onTitleChange = vi.fn<(title: string | null) => void>();
  const screen = await render(
    <MantineProvider>
      <div style={{ display: 'flex', width: 600, height: 400 }}>
        <AppSurface
          ref={handle}
          app={{
            slug: 'notes',
            name: 'Notes',
            id: 'app-notes',
            runtime: 'native',
          }}
          route={route}
          onRouteChange={onRouteChange}
          onTitleChange={onTitleChange}
          latestDeployment="dep-1"
        />
      </div>
    </MantineProvider>,
  );
  await vi.waitFor(() => expect(calls('native_app_open')).toHaveLength(1));
  const request = calls('native_app_open')[0].request as Record<
    string,
    unknown
  >;
  const key = request.key as string;
  return { screen, handle, key, request, onRouteChange, onTitleChange };
}

test("runs a native App in the macOS app's own view, not in a frame", async () => {
  const { screen, handle, key, request, onRouteChange, onTitleChange } =
    await renderNative('/notes');

  expect(screen.container.querySelector('iframe')).toBeNull();
  expect(request).toMatchObject({ appId: 'app-notes', route: '/notes' });

  emit({ type: 'ready', key, deploymentId: 'dep-1', build: 3 });
  // Placed where the surface is, and shown.
  await vi.waitFor(() => {
    const placed = calls('native_app_place').at(-1);
    expect(placed).toMatchObject({ key, visible: true });
    const box = screen.container
      .querySelector('[data-native-app-surface]')!
      .getBoundingClientRect();
    expect(placed!.rect).toEqual({
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
    });
  });

  emit({ type: 'route', key, route: '/notes/7' });
  emit({ type: 'title', key, title: 'Note 7' });
  // Another surface's events are not this one's.
  emit({ type: 'title', key: 'native-other', title: 'Other' });
  await vi.waitFor(() => {
    expect(onRouteChange).toHaveBeenLastCalledWith('/notes/7');
    expect(onTitleChange).toHaveBeenLastCalledWith('Note 7');
  });

  handle.current!.navigate('/notes/8');
  expect(calls('native_app_message').at(-1)).toEqual({
    key,
    message: { type: 'navigate', route: '/notes/8' },
  });

  await screen.unmount();
  expect(calls('native_app_close')).toEqual([{ key }]);
});

test('steps aside behind a picture of the App while a page overlay covers it', async () => {
  const { screen, key } = await renderNative();
  emit({ type: 'ready', key, deploymentId: 'dep-1', build: 3 });
  await vi.waitFor(() => expect(calls('native_app_place')).not.toHaveLength(0));

  const portal = document.createElement('div');
  portal.dataset.portal = 'true';
  portal.innerHTML =
    '<div style="position:fixed;inset:0;background:rgb(0 0 0 / .3)"></div>';
  document.body.append(portal);

  await vi.waitFor(() => {
    expect(calls('native_app_snapshot')).toEqual([{ key }]);
    expect(calls('native_app_cover').at(-1)).toEqual({ key, covered: true });
    expect(screen.container.querySelector('img')).not.toBeNull();
  });

  portal.remove();
  await vi.waitFor(() => {
    expect(calls('native_app_cover').at(-1)).toEqual({ key, covered: false });
    expect(screen.container.querySelector('img')).toBeNull();
  });
});

test('says when a newer deployment is live, once', async () => {
  const { screen, key } = await renderNative();
  emit({ type: 'ready', key, deploymentId: 'dep-0', build: 2 });
  await vi.waitFor(() =>
    expect(
      calls('native_app_message').filter(
        (args) =>
          (args.message as { type: string }).type === 'update-available',
      ),
    ).toHaveLength(1),
  );
  await screen.rerender(
    <MantineProvider>
      <AppSurface
        app={{
          slug: 'notes',
          name: 'Notes',
          id: 'app-notes',
          runtime: 'native',
        }}
        route=""
        latestDeployment="dep-1"
      />
    </MantineProvider>,
  );
  expect(
    calls('native_app_message').filter(
      (args) => (args.message as { type: string }).type === 'update-available',
    ),
  ).toHaveLength(1);
});

test('shows why an App could not start and starts it again on request', async () => {
  const { screen, key } = await renderNative();
  emit({
    type: 'failed',
    key,
    code: 'permission_denied',
    message: "The App's package was refused: revoked: release key k1",
  });
  await vi.waitFor(() =>
    expect(screen.container.textContent).toContain(
      "This App could not start: The App's package was refused: revoked: release key k1",
    ),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await vi.waitFor(() => expect(calls('native_app_open')).toHaveLength(2));
  expect(calls('native_app_close')).toEqual([{ key }]);
  expect((calls('native_app_open')[1].request as { key: string }).key).not.toBe(
    key,
  );
});

test('a web App keeps running in its frame inside the macOS app', async () => {
  const screen = await render(
    <MantineProvider>
      <AppSurface
        app={{ slug: 'notes', name: 'Notes', id: 'app-notes', runtime: 'web' }}
        route=""
      />
    </MantineProvider>,
  );
  expect(screen.container.querySelector('iframe')).not.toBeNull();
  expect(calls('native_app_open')).toHaveLength(0);
});

test('a navigation asked for while the App loads reaches it once it is ready', async () => {
  const { handle, key } = await renderNative('/notes');

  handle.current!.navigate('/notes/9');
  expect(
    calls('native_app_message').filter(
      (args) => (args.message as { type: string }).type === 'navigate',
    ),
  ).toHaveLength(0);

  emit({ type: 'ready', key, deploymentId: 'dep-1', build: 3 });
  await vi.waitFor(() =>
    expect(calls('native_app_message')).toContainEqual({
      key,
      message: { type: 'navigate', route: '/notes/9' },
    }),
  );
});

test('a renamed App starts again from its new slug, as a frame would', async () => {
  const { screen, key } = await renderNative();
  emit({ type: 'ready', key, deploymentId: 'dep-1', build: 3 });

  // The same tree as `renderNative`, so only the slug changes.
  await screen.rerender(
    <MantineProvider>
      <div style={{ display: 'flex', width: 600, height: 400 }}>
        <AppSurface
          app={{
            slug: 'field-notes',
            name: 'Notes',
            id: 'app-notes',
            runtime: 'native',
          }}
          route="/notes"
          latestDeployment="dep-1"
        />
      </div>
    </MantineProvider>,
  );
  await vi.waitFor(() => expect(calls('native_app_open')).toHaveLength(2));
  expect(calls('native_app_close')).toEqual([{ key }]);
});
