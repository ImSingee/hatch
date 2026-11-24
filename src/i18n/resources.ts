import en from './en.json';
import zhCN from './zh-CN.json';
import type { Locale } from './locale';
import type { TranslationResource } from './resources.generated';

/**
 * Every catalog must cover every English key (`satisfies`); extra, empty and
 * untranslated keys are rejected by `pnpm i18n:check`.
 */
export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN satisfies Record<keyof typeof en, string> },
} as const satisfies Record<Locale, { translation: Record<string, string> }>;

export type TranslationKey = keyof typeof en;

/**
 * Keys that take no interpolation values, for data that stores a key and
 * translates it at render time (`t(item.label)`).
 */
export type PlainTranslationKey = {
  [
    Key in TranslationKey
  ]: TranslationResource[Key] extends `${string}{{${string}` ? never : Key;
}[TranslationKey];

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    keySeparator: false;
    nsSeparator: false;
    resources: { translation: TranslationResource };
    strictKeyChecks: true;
  }
}
