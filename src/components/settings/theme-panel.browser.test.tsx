import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { SaveThemeResult, WebTheme } from '~server/theme';
import type { ThemeEntry } from '~server/theme-settings';
import {
  THEME_PRESETS,
  validateThemeDocument,
} from '../../../packages/hatch-design-tokens/src';
import { ThemeLibraryPanel } from './theme-panel';

const fixture = vi.hoisted(() => ({
  active: 'desk',
  themes: [] as ThemeEntry[],
  activate: vi.fn<(input: { data: string }) => Promise<WebTheme>>(),
  save: vi.fn<
    (input: {
      data: { id?: string; document: unknown };
    }) => Promise<SaveThemeResult>
  >(),
  remove: vi.fn<(input: { data: string }) => Promise<{ deleted: string }>>(),
}));

// Server Functions cannot load in the browser project.
vi.mock('~server/theme', () => ({
  getThemeFn: async () => state(),
  listThemesFn: async () => fixture.themes,
  activateThemeFn: fixture.activate,
  saveThemeFn: fixture.save,
  deleteThemeFn: fixture.remove,
}));

function preset(id: 'desk' | 'desk-dark'): ThemeEntry {
  const document = THEME_PRESETS[id].document;
  return {
    id,
    name: document.name!,
    source: 'preset',
    appearance: document.appearance,
    primary: '#3F51C7',
    document,
    valid: true,
    problems: [],
  };
}

const meadow: ThemeEntry = {
  id: 'meadow',
  name: 'Meadow',
  source: 'custom',
  appearance: 'light',
  primary: '#2F6B3A',
  document: {
    name: 'Meadow',
    appearance: 'light',
    colors: {
      ...THEME_PRESETS.desk.document.colors,
      primary: '#2F6B3A',
    },
    radius: 6,
    fonts: THEME_PRESETS.desk.document.fonts,
  },
  valid: true,
  problems: [],
};

function state(): WebTheme {
  return {
    accent: null,
    defaultAccent: 'indigo',
    accents: [],
    dockLabels: false,
    theme: fixture.themes.find((theme) => theme.id === fixture.active)!,
    accentOverridesPrimary: false,
    resolved: {} as WebTheme['resolved'],
  } as WebTheme;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.active = 'desk';
  fixture.themes = [preset('desk'), preset('desk-dark'), meadow];
  fixture.activate.mockImplementation(async ({ data }) => {
    fixture.active = data;
    return state();
  });
  fixture.remove.mockImplementation(async ({ data }) => {
    fixture.themes = fixture.themes.filter((theme) => theme.id !== data);
    return { deleted: data };
  });
});

async function renderPanel() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ModalsProvider>
          <ThemeLibraryPanel />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

test('activates any theme of the library, a dark preset included', async () => {
  const screen = await renderPanel();
  await expect
    .element(screen.getByRole('radio', { name: /^Desk\s*Light/ }))
    .toBeChecked();
  await screen.getByRole('radio', { name: /Desk dark/ }).click();
  await vi.waitFor(() =>
    expect(fixture.activate).toHaveBeenCalledWith({ data: 'desk-dark' }),
  );
  await expect
    .element(screen.getByRole('radio', { name: /Desk dark/ }))
    .toBeChecked();
});

test('creates a theme, showing each rejection translated next to the editor', async () => {
  fixture.save
    .mockResolvedValueOnce({
      ok: false,
      problems: [
        {
          code: 'low_contrast',
          path: '',
          message: 'muted-foreground on background has a contrast of 1.9:1',
          pair: {
            foreground: 'muted-foreground',
            background: 'background',
            ratio: 1.9,
            required: 4.5,
          },
        },
      ],
    })
    .mockResolvedValueOnce({ ok: true, theme: meadow });
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'New theme' }).click();
  const name = screen.getByRole('textbox', { name: 'Name' });
  await userEvent.clear(name);
  await userEvent.type(name, 'Moss');
  await screen.getByRole('button', { name: 'Save theme' }).click();
  await expect
    .element(
      screen.getByText(
        'Muted text on Background is too faint to read (1.9:1; at least 4.5:1 is needed).',
      ),
    )
    .toBeVisible();
  expect(fixture.save).toHaveBeenLastCalledWith({
    data: {
      id: undefined,
      document: expect.objectContaining({ name: 'Moss', appearance: 'light' }),
    },
  });
  await screen.getByRole('button', { name: 'Save theme' }).click();
  await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByRole('button', { name: 'Save theme' }))
    .not.toBeInTheDocument();
});

test('copies under a free name and shows a taken name under the field', async () => {
  fixture.themes.push({ ...meadow, id: 'meadow-copy', name: 'Meadow copy' });
  fixture.save.mockRejectedValueOnce(
    Object.assign(new Error('A theme named "Meadow copy 2" already exists.'), {
      code: 'theme_name_taken',
      params: { name: 'Meadow copy 2' },
    }),
  );
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'Actions for Meadow' }).click();
  await screen.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect
    .element(screen.getByRole('textbox', { name: 'Name' }))
    .toHaveValue('Meadow copy 2');
  await screen.getByRole('button', { name: 'Save theme' }).click();
  await expect
    .element(
      screen.getByText(
        'A theme named “Meadow copy 2” already exists. Choose another name.',
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Save theme' }))
    .toBeVisible();
});

test('starts a theme switched to dark from the dark preset colours', async () => {
  fixture.save.mockResolvedValue({ ok: true, theme: meadow });
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'New theme' }).click();
  await screen.getByRole('dialog').getByText('Dark', { exact: true }).click();
  await screen.getByRole('button', { name: 'Save theme' }).click();
  await vi.waitFor(() =>
    expect(fixture.save).toHaveBeenCalledWith({
      data: {
        id: undefined,
        document: expect.objectContaining({
          appearance: 'dark',
          colors: THEME_PRESETS['desk-dark'].document.colors,
        }),
      },
    }),
  );
  // The saved document passes the platform's rules as it stands.
  expect(
    validateThemeDocument(fixture.save.mock.calls[0][0].data.document).ok,
  ).toBe(true);
});

test('edits a custom theme and deletes it after confirming', async () => {
  fixture.save.mockResolvedValue({ ok: true, theme: meadow });
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'Actions for Meadow' }).click();
  await screen.getByRole('menuitem', { name: 'Edit' }).click();
  await screen.getByRole('button', { name: 'Save theme' }).click();
  await vi.waitFor(() =>
    expect(fixture.save).toHaveBeenCalledWith({
      data: { id: 'meadow', document: meadow.document },
    }),
  );

  await screen.getByRole('button', { name: 'Actions for Meadow' }).click();
  await screen.getByRole('menuitem', { name: 'Delete' }).click();
  await screen.getByRole('button', { name: 'Delete' }).click();
  await vi.waitFor(() =>
    expect(fixture.remove).toHaveBeenCalledWith({ data: 'meadow' }),
  );
});

test('keeps presets and the active theme from being deleted', async () => {
  fixture.active = 'meadow';
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'Actions for Meadow' }).click();
  await expect
    .element(
      screen.getByRole('menuitem', {
        name: 'Delete (choose another theme first)',
      }),
    )
    .toBeDisabled();
  await userEvent.keyboard('{Escape}');
  await expect
    .element(screen.getByRole('menuitem', { name: /Delete/ }))
    .not.toBeInTheDocument();
  await screen.getByRole('button', { name: 'Actions for Desk dark' }).click();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Duplicate' }))
    .toBeVisible();
  expect(
    screen.getByRole('menuitem', { name: /Delete/ }).elements(),
  ).toHaveLength(0);
});
