/**
 * `pnpm i18n:types` regenerates the translation key types from en.json.
 * `pnpm i18n:check` (CI) fails on missing, empty, untranslated or extra keys,
 * mismatched placeholders, and stale generated types.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { format, type FormatConfig } from 'oxfmt';
import {
  checkCatalogs,
  translationTypesSource,
  type Catalog,
} from '../src/i18n/catalog-check.ts';
import { LOCALES, SOURCE_LOCALE } from '../src/i18n/locale.ts';

const directory = new URL('../src/i18n/', import.meta.url);
const typesFile = new URL('resources.generated.d.ts', directory);
const SAME_AS_SOURCE = 'same-as-source.json';

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, directory), 'utf8')) as T;
}

const catalogs: Record<string, Catalog> = {};
for (const name of await readdir(directory)) {
  if (!name.endsWith('.json') || name === SAME_AS_SOURCE) continue;
  catalogs[name.slice(0, -'.json'.length)] = await readJson<Catalog>(name);
}
const source = catalogs[SOURCE_LOCALE];
if (!source) throw new Error(`src/i18n/${SOURCE_LOCALE}.json is missing.`);

const config = JSON.parse(
  await readFile(new URL('../.oxfmtrc.json', import.meta.url), 'utf8'),
) as FormatConfig;
const formatted = await format(
  'resources.generated.d.ts',
  translationTypesSource(source),
  config,
);
if (formatted.errors.length) {
  throw new Error(JSON.stringify(formatted.errors));
}

if (!process.argv.includes('--check')) {
  await writeFile(typesFile, formatted.code);
  console.log('Wrote src/i18n/resources.generated.d.ts');
  process.exit(0);
}

const errors = checkCatalogs({
  sourceLocale: SOURCE_LOCALE,
  locales: LOCALES,
  catalogs,
  sameAsSource: await readJson(SAME_AS_SOURCE),
});
const current = await readFile(typesFile, 'utf8').catch(() => '');
if (current !== formatted.code) {
  errors.push(
    'src/i18n/resources.generated.d.ts is out of date. Run pnpm i18n:types.',
  );
}

if (errors.length) {
  console.error(`Translation check failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('See "Internationalization" in AGENTS.md.');
  process.exit(1);
}
console.log(
  `Translations complete: ${Object.keys(source).length} keys in ` +
    `${LOCALES.join(', ')}.`,
);
