import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useSyncExternalStore } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AppearancePanels } from './appearance-panels';

/** The signed-in user; the test switches it the way another tab would. */
const session = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let userId = 'alice';
  return {
    get: () => userId,
    set(next: string) {
      userId = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock('~auth/client', () => ({
  authClient: {
    useSession: () => {
      const userId = useSyncExternalStore(session.subscribe, session.get);
      return { data: { user: { id: userId } }, isPending: false };
    },
  },
}));
// The server answers for whoever the session is now.
vi.mock('~server/theme', async () => {
  const { THEME_PRESETS } =
    await import('../../../packages/hatch-design-tokens/src');
  const preset = (id: 'desk' | 'desk-dark') => ({
    id,
    name: THEME_PRESETS[id].document.name ?? id,
    source: 'preset' as const,
    appearance: THEME_PRESETS[id].document.appearance,
    primary: THEME_PRESETS[id].document.colors.primary,
    document: THEME_PRESETS[id].document,
    valid: true,
    problems: [],
  });
  return {
    getThemeFn: async () => ({
      userId: session.get(),
      accent: session.get() === 'alice' ? 'teal' : 'clay',
      defaultAccent: 'indigo',
      accents: ['indigo', 'teal', 'clay', 'violet'].map((name) => ({
        name,
        color: '#888',
      })),
      dockLabels: session.get() === 'alice',
      // Each user has their own active theme from the shared library.
      theme: preset(session.get() === 'alice' ? 'desk' : 'desk-dark'),
      accentOverridesPrimary: false,
      resolved: {},
    }),
    listThemesFn: async () => [preset('desk'), preset('desk-dark')],
    setThemeAccentFn: vi.fn<() => Promise<void>>(),
    setDockLabelsFn: vi.fn<() => Promise<void>>(),
    activateThemeFn: vi.fn<() => Promise<void>>(),
    deleteThemeFn: vi.fn<() => Promise<void>>(),
    saveThemeFn: vi.fn<() => Promise<void>>(),
  };
});
vi.mock('~server/interface-preference-settings', () => ({
  getInterfacePreferenceSettings: async () => ({
    userId: session.get(),
    language: null,
  }),
  updateInterfacePreferenceSettings: vi.fn<() => Promise<void>>(),
}));

test('the panels follow an account switched in another tab', async () => {
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MantineProvider>
        <Suspense fallback="loading">
          <AppearancePanels />
        </Suspense>
      </MantineProvider>
    </QueryClientProvider>,
  );
  await expect
    .element(screen.getByRole('radio', { name: 'Teal' }))
    .toBeChecked();
  await expect
    .element(screen.getByRole('radio', { name: /^Desk\s*Light/ }))
    .toBeChecked();

  session.set('bob');
  await expect
    .element(screen.getByRole('radio', { name: /Desk dark/ }))
    .toBeChecked();
  await expect
    .element(screen.getByRole('radio', { name: 'Clay' }))
    .toBeChecked();
  await expect
    .element(screen.getByRole('switch', { name: /dock/i }))
    .not.toBeChecked();
});
