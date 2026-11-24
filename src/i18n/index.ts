import { createInstance } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import {
  LOCALES,
  SOURCE_LOCALE,
  isLocale,
  persistLocale,
  readLocale,
  type Locale,
} from './locale';
import { resources, type PlainTranslationKey } from './resources';

export { LANGUAGE_NAMES, LOCALES, isLocale, type Locale } from './locale';
export type { PlainTranslationKey, TranslationKey } from './resources';

/**
 * The platform Web UI's single i18next instance. Resources are bundled, so it
 * is ready synchronously before the first render.
 */
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources,
  lng: readLocale(),
  fallbackLng: SOURCE_LOCALE,
  supportedLngs: LOCALES,
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  // React escapes rendered text already.
  interpolation: { escapeValue: false },
});

function currentLocale(): Locale {
  return isLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : SOURCE_LOCALE;
}

/** Keep `<html lang>` on the active language (the shell is prerendered as en). */
function applyDocumentLanguage() {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLocale();
  }
}

applyDocumentLanguage();
i18n.on('languageChanged', applyDocumentLanguage);

/** Switch this browser's language in place and remember the choice. */
export async function changeLocale(locale: Locale) {
  persistLocale(locale);
  await i18n.changeLanguage(locale);
}

/** `t` for UI copy and the active locale for `Intl` formatting. */
export function useI18n() {
  const { t, i18n: instance } = useTranslation();
  const locale = isLocale(instance.resolvedLanguage)
    ? instance.resolvedLanguage
    : SOURCE_LOCALE;
  return { t, locale };
}

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * Display text for a caught error. An error with a stable `code` whose
 * `error.<code>` key exists is translated (with its `params`). Otherwise the
 * source language keeps showing the error's own English message, and other
 * languages show the translated `fallback`, so no untranslated server
 * sentence reaches them.
 */
export function translateError(
  t: Translate,
  locale: Locale,
  error: unknown,
  fallback: PlainTranslationKey,
): string {
  const details =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          params?: unknown;
          message?: unknown;
        })
      : {};
  if (typeof details.code === 'string' && details.code) {
    const key = `error.${details.code}`;
    if (i18n.exists(key)) {
      const params =
        details.params && typeof details.params === 'object'
          ? details.params
          : {};
      // Codes come from the server at runtime, so the key is checked with
      // `exists` instead of the compile-time key types.
      const translate = i18n.t as unknown as (
        key: string,
        options: object,
      ) => string;
      return translate(key, params);
    }
  }
  if (
    locale === SOURCE_LOCALE &&
    typeof details.message === 'string' &&
    details.message
  ) {
    return details.message;
  }
  return t(fallback);
}

/**
 * `translateError` outside React (the global mutation toast), using the
 * language active when it is called.
 */
export function errorText(error: unknown, fallback: PlainTranslationKey) {
  return translateError(i18n.t, currentLocale(), error, fallback);
}

/** `translateError` bound to the active language. */
export function useErrorText() {
  const { t, locale } = useI18n();
  return (error: unknown, fallback: PlainTranslationKey) =>
    translateError(t, locale, error, fallback);
}
