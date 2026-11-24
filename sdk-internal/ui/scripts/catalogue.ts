import fs from 'node:fs';
import type { GeneratedIcon } from './icons.ts';
const FILE = new URL(
  '../../../skills/building-apps/references/design-system.md',
  import.meta.url,
);
export function buildCatalogueReference(
  _icons: readonly GeneratedIcon[],
): string {
  return fs.existsSync(FILE)
    ? fs.readFileSync(FILE, 'utf8')
    : '# Design system\n';
}
