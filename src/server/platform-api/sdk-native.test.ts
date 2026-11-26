/**
 * The SDK a checkout receives carries everything a native App needs: the
 * `@hatch/ui` source, and the NSH configuration a deploy generates, which the
 * CLI completes with the App's name, id and entry into byte-identical files.
 * Web and Deno resolution never see the NSH library.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNativeConfig } from '../../../packages/hatch-cli/src/preparation';
import { writeFiles } from '../../../packages/hatch-cli/src/workspace';
import { nativeEntryTsconfig, nativeNshJson } from '../apps/native/nsh-config';
import { sdkPayload } from './sdk';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, child)));
    else out.push(child);
  }
  return out.sort();
}

describe('the App SDK payload', () => {
  it('ships @hatch/ui as its source and keeps it out of web resolution', async () => {
    const { files } = await sdkPayload();
    const shipped = files
      .map((file) => file.path)
      .filter((file) => file.startsWith('sdk/@hatch/ui/dist/'))
      .map((file) => file.slice('sdk/@hatch/ui/dist/'.length))
      .sort();
    expect(shipped).toEqual(await listFiles('sdk-internal/ui/src'));
    const text = (name: string) =>
      Buffer.from(
        files.find((file) => file.path === name)!.contentBase64,
        'base64',
      ).toString('utf8');
    expect(text('import-map.json')).not.toContain('@hatch/ui');
    expect(text('tsconfig.json')).not.toContain('@hatch/ui');
  });

  it('lets the CLI write the nsh.json and app/tsconfig.json a deploy writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-native-sdk-'));
    roots.push(root);
    await writeFiles(path.join(root, '.hatch'), (await sdkPayload()).files);
    await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.hatch/\n');
    const app = {
      id: '01habit-tracker',
      name: 'Habit tracker',
      entry: 'app/main.tsx',
    };

    await writeNativeConfig(root, app);
    await writeNativeConfig(root, app);

    await expect(
      fs.readFile(path.join(root, 'nsh.json'), 'utf8'),
    ).resolves.toBe(nativeNshJson(app));
    await expect(
      fs.readFile(path.join(root, 'app', 'tsconfig.json'), 'utf8'),
    ).resolves.toBe(nativeEntryTsconfig());
    // Kept out of Git even where the App's .gitignore predates native Apps,
    // listed once however often the checkout is prepared.
    await expect(
      fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8'),
    ).resolves.toBe('.hatch/\n/nsh.json\n/app/tsconfig.json\n.nsh/\n');
  });
});
