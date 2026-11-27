/**
 * Test helper: the source of a frontend-only native App (the default
 * template with a one-page `app/`), and the tools its package tests need.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nshBinary } from '../nsh-toolchain';
import { nshpkgBinary } from '../nshpkg';

const templateDir = path.resolve('templates/default-app');
const fixtureUi = path.resolve(
  'src/server/apps/native/test-fixtures/native-app/app/custom/ui.tsx',
);

/** Whether `nsh` and `hatch-nshpkg` are here; in CI a missing one fails. */
export function packageToolsAvailable(): boolean {
  try {
    nshBinary();
    nshpkgBinary();
    return true;
  } catch (error) {
    if (process.env.CI) throw error;
    return false;
  }
}

/** Write a native App whose page says `title` into `dir` (a new directory). */
export async function writePackageSource(
  dir: string,
  app: { id: string; name: string; title: string },
): Promise<void> {
  await fs.cp(templateDir, dir, { recursive: true });
  for (const unused of ['app', 'backend', 'widgets', 'proto', 'data']) {
    await fs.rm(path.join(dir, unused), { recursive: true, force: true });
  }
  await fs.writeFile(
    path.join(dir, 'manifest.ts'),
    `import { defineAppManifest } from '@hatch/app';

export default defineAppManifest({
  id: ${JSON.stringify(app.id)},
  name: ${JSON.stringify(app.name)},
  description: 'Package fixture',
  compatibilityVersion: 2,
  capabilities: { frontend: true },
  app: {
    entry: 'app/main.tsx',
    runtime: 'native',
    routes: [{ path: '/', description: 'One page' }],
  },
});
`,
  );
  const pkg = path.join(dir, 'package.json');
  await fs.writeFile(
    pkg,
    (await fs.readFile(pkg, 'utf8')).replaceAll('__APP_ID__', app.id),
  );
  await fs.mkdir(path.join(dir, 'app', 'custom'), { recursive: true });
  await fs.copyFile(fixtureUi, path.join(dir, 'app', 'custom', 'ui.tsx'));
  await fs.writeFile(
    path.join(dir, 'app', 'main.tsx'),
    `import { Label, mount, Page } from './custom/ui.tsx';

mount(() => (
  <Page title=${JSON.stringify(app.title)}>
    <Label>Package fixture</Label>
  </Page>
));
`,
  );
}
