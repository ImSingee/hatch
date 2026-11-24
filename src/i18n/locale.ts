/** The languages the platform Web UI ships, in the order the picker lists them. */
export const LOCALES = ['en', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

/** Each language in its own words, for the picker. Never translated. */
export const LANGUAGE_NAMES = {
  en: 'English',
  'zh-CN': '简体中文',
} as const satisfies Record<Locale, string>;

/** The language every catalog is checked against and falls back to. */
export const SOURCE_LOCALE: Locale = 'en';

/**
 * The chosen language is a display preference of this browser, like the
 * colour scheme of an OS: it is kept in local storage and never sent to the
 * server.
 */
export const LOCALE_STORAGE_KEY = 'hatch.locale';

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

/**
 * The saved choice wins; otherwise the browser's first preferred language
 * decides. Any Chinese preference selects Simplified Chinese, the only
 * Chinese catalog; everything else falls back to English.
 */
export function detectLocale(
  saved: unknown,
  languages: readonly string[],
): Locale {
  if (isLocale(saved)) return saved;
  try {
    const { language } = new Intl.Locale(languages[0] ?? SOURCE_LOCALE);
    return language === 'zh' ? 'zh-CN' : SOURCE_LOCALE;
  } catch {
    return SOURCE_LOCALE;
  }
}

/** The language for this browser. Safe to call where no DOM exists. */
export function readLocale(): Locale {
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can be disabled; the browser preference still applies.
  }
  const navigator = globalThis.navigator as Navigator | undefined;
  const languages = navigator?.languages?.length
    ? navigator.languages
    : navigator?.language
      ? [navigator.language]
      : [];
  return detectLocale(saved, languages);
}

export function persistLocale(locale: Locale) {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Keep the choice for this page load only.
  }
}
