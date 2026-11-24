/**
 * Refresh the bundled model catalog from aidy-models.
 *
 *   pnpm catalog:sync                 # latest master
 *   pnpm catalog:sync --ref <commit>  # a pinned commit
 *   pnpm catalog:sync --file <path>   # a local models.json
 *
 * Prints a summary of what changed so the diff can be reviewed in the PR.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AIDY_MODELS_REPOSITORY,
  assertPlausibleUpdate,
  buildCatalog,
} from '../src/server/model-catalog/build.ts';
import {
  catalogSchema,
  type Catalog,
} from '../src/server/model-catalog/types.ts';

const target = fileURLToPath(
  new URL('../src/server/model-catalog/catalog.json', import.meta.url),
);

const { values } = parseArgs({
  options: {
    ref: { type: 'string', default: 'master' },
    file: { type: 'string' },
  },
});

async function loadRaw(): Promise<unknown> {
  if (values.file) return JSON.parse(await readFile(values.file, 'utf8'));
  const ref = values.ref ?? 'master';
  if (!/^[\w./-]+$/.test(ref))
    throw new Error('--ref must be a branch or commit.');
  const url = `https://raw.githubusercontent.com/${AIDY_MODELS_REPOSITORY}/${ref}/models.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

async function loadCurrent(): Promise<Catalog | null> {
  try {
    return catalogSchema.parse(JSON.parse(await readFile(target, 'utf8')));
  } catch {
    return null;
  }
}

function modelKeys(catalog: Catalog): Set<string> {
  return new Set(
    Object.entries(catalog.models).flatMap(([provider, models]) =>
      models.map((model) => `${provider}/${model.id}`),
    ),
  );
}

const { catalog, warnings } = buildCatalog(await loadRaw());
const current = await loadCurrent();
if (current) assertPlausibleUpdate(catalog, current);

await writeFile(target, `${JSON.stringify(catalog, null, 1)}\n`);

for (const warning of warnings) console.warn(`warning: ${warning}`);
const after = modelKeys(catalog);
console.log(
  `Wrote ${catalog.providers.length} providers and ${after.size} models (data generated ${catalog.source.generatedAt}).`,
);
if (current) {
  const before = modelKeys(current);
  const added = [...after].filter((key) => !before.has(key));
  const removed = [...before].filter((key) => !after.has(key));
  if (added.length) console.log(`Added:\n  ${added.join('\n  ')}`);
  if (removed.length) console.log(`Removed:\n  ${removed.join('\n  ')}`);
}
