/**
 * The translation gate CI runs (`pnpm i18n:check`). A key added to the
 * English catalog fails the build until every other catalog translates it.
 * Pure so the rules can be tested without touching the real catalogs.
 */

export type Catalog = Record<string, unknown>;

export type CatalogSet = {
  /** The source language every other catalog is checked against. */
  sourceLocale: string;
  /** Every shipped locale, the source included. */
  locales: readonly string[];
  /** Parsed catalog per locale; a missing entry is a missing file. */
  catalogs: Record<string, Catalog | undefined>;
  /**
   * Keys whose translation is intentionally the same text as the source,
   * such as product names, per locale.
   */
  sameAsSource: Record<string, readonly string[] | undefined>;
};

/** `{{count, number}}` → `count`; `$t(key)` nesting is compared verbatim. */
function placeholders(value: string) {
  const variables = [
    ...value.matchAll(/\{\{\s*([^,}]+?)\s*(?:,[^}]*)?\}\}/g),
  ].map((match) => `{{${match[1]}}}`);
  const nested = [...value.matchAll(/\$t\(([^)]*)\)/g)].map(
    (match) => `$t(${match[1]})`,
  );
  return [...variables, ...nested].sort();
}

export function checkCatalogs({
  sourceLocale,
  locales,
  catalogs,
  sameAsSource,
}: CatalogSet): string[] {
  const errors: string[] = [];
  const source = catalogs[sourceLocale];
  if (!source) return [`${sourceLocale}: the source catalog is missing.`];

  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') {
      errors.push(`${sourceLocale}: "${key}" must be a string.`);
    } else if (!value.trim()) {
      errors.push(`${sourceLocale}: "${key}" is empty.`);
    }
  }

  for (const locale of Object.keys(catalogs)) {
    if (!locales.includes(locale)) {
      errors.push(`${locale}: catalog for a locale that is not shipped.`);
    }
  }
  for (const locale of Object.keys(sameAsSource)) {
    if (locale === sourceLocale || !locales.includes(locale)) {
      errors.push(`${locale}: same-as-source list for an unknown locale.`);
    }
  }

  for (const locale of locales) {
    if (locale === sourceLocale) continue;
    const catalog = catalogs[locale];
    if (!catalog) {
      errors.push(`${locale}: the catalog is missing.`);
      continue;
    }
    const allowed = new Set(sameAsSource[locale] ?? []);

    for (const [key, sourceValue] of Object.entries(source)) {
      if (typeof sourceValue !== 'string') continue;
      const value = catalog[key];
      if (value === undefined) {
        errors.push(`${locale}: "${key}" has no translation.`);
        continue;
      }
      if (typeof value !== 'string') {
        errors.push(`${locale}: "${key}" must be a string.`);
        continue;
      }
      if (!value.trim()) {
        errors.push(`${locale}: "${key}" is empty.`);
        continue;
      }
      if (value === sourceValue && !allowed.has(key)) {
        errors.push(
          `${locale}: "${key}" is still the ${sourceLocale} text. ` +
            'Translate it, or list the key under ' +
            `"${locale}" in same-as-source.json if it is a name that ` +
            'stays the same.',
        );
      }
      const expected = placeholders(sourceValue);
      const actual = placeholders(value);
      if (expected.join('\n') !== actual.join('\n')) {
        errors.push(
          `${locale}: "${key}" uses ${JSON.stringify(actual)} ` +
            `but ${sourceLocale} uses ${JSON.stringify(expected)}.`,
        );
      }
    }

    for (const key of Object.keys(catalog)) {
      if (!(key in source)) {
        errors.push(
          `${locale}: "${key}" is not in the ${sourceLocale} catalog. ` +
            'Remove it from every catalog, or add it to the source.',
        );
      }
    }

    for (const key of allowed) {
      if (!(key in source)) {
        errors.push(`${locale}: same-as-source key "${key}" does not exist.`);
      } else if (catalog[key] !== source[key]) {
        errors.push(
          `${locale}: same-as-source key "${key}" is translated; ` +
            'remove it from same-as-source.json.',
        );
      }
    }
  }

  return errors;
}

/**
 * Literal types for the source catalog, so `t()` rejects unknown keys and
 * checks interpolation variables. Runtime text stays in the JSON files.
 */
export function translationTypesSource(source: Catalog) {
  return `// Generated from en.json by \`pnpm i18n:types\`. Do not edit.
// Literal types keep i18next key and interpolation checks; text stays in JSON.
export type TranslationResource = ${JSON.stringify(source, null, 2)};
`;
}
