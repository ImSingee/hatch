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
import { resources } from './resources';

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
