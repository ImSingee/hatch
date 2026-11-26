/**
 * Regenerates the files `@hatch/ui` derives from the design tokens, the icon
 * list and the component types:
 *
 *   node_modules/.bin/tsx sdk-internal/ui/scripts/generate.ts [--check]
 *
 * `--check` writes nothing and exits 1 when a file is out of date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, generatedFiles } from './outputs.ts';

const check = process.argv.includes('--check');
let stale = 0;
for (const file of generatedFiles()) {
  const current = fs.existsSync(file.path)
    ? fs.readFileSync(file.path, 'utf8')
    : null;
  if (current === file.content) continue;
  const relative = path.relative(REPO_ROOT, file.path);
  if (check) {
    stale += 1;
    console.error(`out of date: ${relative}`);
    continue;
  }
  fs.mkdirSync(path.dirname(file.path), { recursive: true });
  fs.writeFileSync(file.path, file.content);
  console.log(`wrote ${relative}`);
}
if (stale > 0) {
  console.error(
    'Run: node_modules/.bin/tsx sdk-internal/ui/scripts/generate.ts',
  );
  process.exit(1);
}
