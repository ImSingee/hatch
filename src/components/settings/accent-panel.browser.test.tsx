import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { WebTheme } from '~server/theme';
import { AccentPanel } from './accent-panel';

const fixture = vi.hoisted(() => ({
  theme: null as unknown as WebTheme,
  setAccent: vi.fn<(input: { data: string | null }) => Promise<WebTheme>>(),
}));

// Server Functions cannot load in the browser project.
vi.mock('~server/theme', () => ({
  getThemeFn: async () => fixture.theme,
  setThemeAccentFn: fixture.setAccent,
}));

const meadow = {
  name: 'Meadow',
  appearance: 'light',
  colors: {
    background: '#F3F6EF',
    foreground: '#1C2A1F',
    card: '#FFFFFF',
    primary: '#2F6B3A',
    secondary: '#E8EFE3',
    muted: '#E8EFE3',
    'muted-foreground': '#4B5B4E',
    border: '#D9E3D3',
    destructive: '#B91C1C',
  },
  radius: 6,
  fonts: { sans: 'Nunito', mono: 'JetBrains Mono' },
} as const;

function themeWith(accent: 'teal' | null, overrides: boolean): WebTheme {
  return {
    accent,
    defaultAccent: 'indigo',
    accents: [
      { name: 'indigo', color: '#3F51C7' },
      { name: 'teal', color: '#0F766E' },
    ],
    dockLabels: false,
    theme: {
      id: 'meadow-id',
      name: 'Meadow',
      source: 'custom',
      appearance: 'light',
      primary: '#2F6B3A',
      document: meadow,
      valid: true,
      problems: [],
    },
    accentOverridesPrimary: overrides,
    // The panel does not read the resolved tokens.
    resolved: {} as WebTheme['resolved'],
    userId: 'owner',
  } as WebTheme;
}

async function renderPanel(theme: WebTheme) {
  fixture.theme = theme;
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <AccentPanel userId="owner" />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

test('says when the accent hides the primary of a custom theme, and clears once Theme colour is chosen', async () => {
  fixture.setAccent.mockResolvedValue(themeWith(null, false));
  const screen = await renderPanel(themeWith('teal', true));
  await expect
    .element(
      screen.getByText(
        /replaces the primary colour of the custom theme “Meadow”/,
      ),
    )
    .toBeVisible();
  await screen.getByRole('radio', { name: 'Theme colour' }).click();
  await vi.waitFor(() =>
    expect(fixture.setAccent).toHaveBeenCalledWith({ data: null }),
  );
  await expect
    .element(screen.getByText(/replaces the primary colour/))
    .not.toBeInTheDocument();
});

test('says nothing while each theme shows its own primary', async () => {
  const screen = await renderPanel(themeWith(null, false));
  await expect
    .element(screen.getByRole('radio', { name: 'Theme colour' }))
    .toBeChecked();
  expect(
    screen.getByText(/replaces the primary colour/).elements(),
  ).toHaveLength(0);
});
