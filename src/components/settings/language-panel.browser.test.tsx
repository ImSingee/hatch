import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { LocaleSync } from '~components/system/locale-sync';
import { i18n } from '~i18n';
import { LOCALE_STORAGE_KEY } from '~i18n/locale';
import type { InterfacePreferenceSettings } from '~server/interface-preference-settings';
import { LanguagePanel } from './language-panel';

const fixture = vi.hoisted(() => ({
  saved: { userId: 'a', language: null } as InterfacePreferenceSettings,
  saveFailure: false,
  update:
    vi.fn<
      (input: {
        data: { language: 'en' | 'zh-CN' };
      }) => Promise<InterfacePreferenceSettings>
    >(),
  error: vi.fn<() => void>(),
}));
vi.mock('~auth/client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'a' } }, isPending: false }),
  },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn<() => void>(), error: fixture.error },
}));
vi.mock('~server/interface-preference-settings', () => ({
  getInterfacePreferenceSettings: async () => fixture.saved,
  updateInterfacePreferenceSettings: fixture.update,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.saved = { userId: 'a', language: null };
  fixture.saveFailure = false;
  fixture.update.mockImplementation(async ({ data }) => {
    if (fixture.saveFailure) throw new Error('Save request failed');
    fixture.saved = { userId: 'a', ...data };
    return fixture.saved;
  });
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
});

afterEach(async () => {
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  await i18n.changeLanguage('en');
});

function mount(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>,
  );
}

test("the account's language replaces the one this browser remembered", async () => {
  fixture.saved = { userId: 'a', language: 'zh-CN' };
  await mount(<LocaleSync />);
  await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe('zh-CN'));
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
});

test('a browser keeps its own language until the account has one', async () => {
  await mount(<LocaleSync />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(i18n.resolvedLanguage).toBe('en');
  expect(fixture.update).not.toHaveBeenCalled();
});

test('saves the picked language to the account and reverts when saving fails', async () => {
  const screen = await mount(
    <>
      <LocaleSync />
      <LanguagePanel />
    </>,
  );
  await screen.getByText('简体中文').click();
  await expect.element(screen.getByText('语言')).toBeVisible();
  expect(fixture.update).toHaveBeenCalledWith({ data: { language: 'zh-CN' } });
  expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');

  // A failed save says it switched back, in the language it switched back
  // to, rather than showing the raw request error.
  fixture.saveFailure = true;
  await screen.getByText('English').click();
  await vi.waitFor(() => expect(fixture.error).toHaveBeenCalledOnce());
  await expect.element(screen.getByText('语言')).toBeVisible();
  expect(i18n.resolvedLanguage).toBe('zh-CN');
  expect(fixture.error).toHaveBeenCalledWith(
    i18n.t('appearance.language.saveFailed'),
  );
});

test('the language on screen can be saved while the account has none', async () => {
  const screen = await mount(
    <>
      <LocaleSync />
      <LanguagePanel />
    </>,
  );
  const english = screen.getByRole('radio', { name: 'English' });
  await expect
    .element(screen.getByText(/not saved to your account yet/i))
    .toBeVisible();
  await expect.element(english).not.toBeChecked();

  await screen.getByText('English').click();
  expect(fixture.update).toHaveBeenCalledWith({ data: { language: 'en' } });
  await expect.element(english).toBeChecked();
  await expect
    .element(screen.getByText(/not saved to your account yet/i))
    .not.toBeInTheDocument();
});
