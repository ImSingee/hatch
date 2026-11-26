/**
 * Deploy checks of `native` (NSH) App frontends, one fixture per rule, built
 * with the real pinned `nsh` (CI installs it from the Dockerfile pin).
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppBuildError, buildApp } from '../build';
import { NATIVE_HOST_CALLS, nshAppId } from './build-native';
import { nshBinary, NSH_RELEASE_SHA256, NSH_VERSION } from './nsh-toolchain';
import { nshRuntimeDir } from './runtime-store';

const templateDir = path.resolve('templates/default-app');
const fixtureDir = path.resolve(
  'src/server/apps/native/test-fixtures/native-app',
);
const tempDirs: string[] = [];

function nshAvailable(): boolean {
  try {
    nshBinary();
    return true;
  } catch (error) {
    // CI installs the pinned release; a missing one there is a failure.
    if (process.env.CI) throw error;
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

/**
 * The default template with the fixture's native frontend and the id `demo`.
 * `edit` maps App-relative paths to new contents (null deletes the file).
 */
async function nativeSource(
  edit: Record<string, string | null> = {},
): Promise<{ sourceDir: string; outputDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-native-build-'));
  tempDirs.push(root);
  const sourceDir = path.join(root, 'src');
  await fs.cp(templateDir, sourceDir, { recursive: true });
  await fs.rm(path.join(sourceDir, 'app'), { recursive: true, force: true });
  await fs.cp(fixtureDir, sourceDir, { recursive: true });
  for (const file of ['manifest.ts', 'package.json']) {
    const target = path.join(sourceDir, file);
    await fs.writeFile(
      target,
      (await fs.readFile(target, 'utf8'))
        .replaceAll(
          '__APP_ID__',
          file === 'manifest.ts' ? JSON.stringify('demo') : 'demo',
        )
        .replaceAll('__APP_NAME__', JSON.stringify('Demo')),
    );
  }
  for (const [file, contents] of Object.entries(edit)) {
    const target = path.join(sourceDir, file);
    if (contents === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return { sourceDir, outputDir: path.join(root, 'out') };
}

async function fixtureFile(file: string): Promise<string> {
  return fs.readFile(path.join(fixtureDir, file), 'utf8');
}

/** The line of `needle` in `source`, 1-based. */
function lineOf(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`fixture lacks ${needle}`);
  return source.slice(0, index).split('\n').length;
}

async function buildError(edit: Record<string, string | null>) {
  const { sourceDir, outputDir } = await nativeSource(edit);
  // A previous output survives a build whose source fails a check.
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'previous.txt'), 'kept', 'utf8');
  const error = await buildApp('demo', { sourceDir, outputDir }).then(
    () => null,
    (cause: unknown) => cause,
  );
  await expect(
    fs.readFile(path.join(outputDir, 'previous.txt'), 'utf8'),
  ).resolves.toBe('kept');
  // A failed check is a definite rejection whose message reaches the CLI
  // and the Agent, not an internal failure with an unknown outcome.
  // (The public API maps a 4xx AppError to BAD_REQUEST with its message.)
  expect(error).toBeInstanceOf(AppBuildError);
  expect((error as AppBuildError).status).toBe(400);
  return (error as AppBuildError).message;
}

describe('the pinned NSH release', () => {
  it('matches the Dockerfile pin', async () => {
    const dockerfile = await fs.readFile('Dockerfile', 'utf8');
    const arg = (name: string) =>
      new RegExp(`^ARG ${name}=(.+)$`, 'm').exec(dockerfile)?.[1];
    expect(arg('NSH_VERSION')).toBe(NSH_VERSION);
    expect(arg('NSH_LINUX_X86_64_SHA256')).toBe(
      NSH_RELEASE_SHA256['nsh-linux-x86_64.tar.gz'],
    );
    expect(arg('NSH_LINUX_ARM64_SHA256')).toBe(
      NSH_RELEASE_SHA256['nsh-linux-arm64.tar.gz'],
    );
    expect(arg('NSH_WEB_SHA256')).toBe(NSH_RELEASE_SHA256['nsh-web.tar.gz']);
  });
});

describe('the NSH app id', () => {
  it('keeps distinct Hatch App ids in distinct NSH storage namespaces', () => {
    const ids = [
      'habit-tracker',
      'habittracker',
      'habitx2dtracker',
      'x',
      'x78',
    ];
    const mapped = ids.map(nshAppId);
    expect(new Set(mapped).size).toBe(ids.length);
    for (const id of mapped) expect(id).toMatch(/^dev\.hatch\.app\.[a-z0-9]+$/);
  });
});

describe.skipIf(!nshAvailable())(
  'native App deploy checks',
  { timeout: 240_000 },
  () => {
    it('builds the player page, the linked module and the native bundle', async () => {
      const { sourceDir, outputDir } = await nativeSource();
      const result = await buildApp('demo', {
        sourceDir,
        outputDir,
        deploymentId: 'deployment-1',
      });

      expect(result.normalized.app).toMatchObject({
        runtime: 'native',
        nshVersion: NSH_VERSION,
      });
      expect(result.log).toContain('native custom files');
      expect(result.log).toContain('app/custom/ui.tsx');
      // NSH reads every key of the generated nsh.json: one it ignored
      // (a theme or Tailwind key of another release) would warn here.
      expect(result.log).not.toMatch(/^warn\b.*nsh\.json/m);
      // Widgets stay on the web runtime.
      await fs.access(path.join(outputDir, 'widgets', 'counter.js'));
      await fs.access(path.join(outputDir, 'app', 'bundle.js'));

      const page = await fs.readFile(
        path.join(outputDir, 'app', 'index.html'),
        'utf8',
      );
      expect(page).toContain('<meta name="hatch-app-runtime" content="native"');
      // No inline script runs: the page works under `script-src 'self'`.
      expect(page).not.toMatch(
        /<script(?![^>]*(?:type="application\/json"|src=))/,
      );
      const config = JSON.parse(
        /<script type="application\/json" id="hatch-player">([\s\S]*?)<\/script>/.exec(
          page,
        )![1],
      ) as {
        deploymentId: string;
        grant: string;
        rpc: { url: string; methods: Record<string, string[]> };
        data: { url: string };
        runtime: { base: string; module: string; wasm: string };
        app: { code: string };
        themes: Record<string, unknown>;
      };
      // The grant is exactly the hatch.* calls: no network, files or URLs.
      expect(JSON.parse(config.grant)).toEqual({
        host: [...NATIVE_HOST_CALLS],
      });
      expect(config.deploymentId).toBe('deployment-1');
      expect(config.rpc).toEqual({
        url: '/api/app/demo/rpc',
        methods: { 'app.v1.CounterService': ['GetCount', 'Increment'] },
      });
      expect(config.data.url).toBe('/api/app/demo/data');
      expect(Object.keys(config.themes).sort()).toEqual([
        'clay',
        'indigo',
        'teal',
        'violet',
      ]);
      // App code ships with the deployment; the engine goes to the shared,
      // content-addressed runtime.
      await fs.access(path.join(outputDir, 'app', config.app.code));
      expect(config.runtime.base).toBe(`/api/app-runtime/nsh/${NSH_VERSION}/`);
      for (const file of [config.runtime.module, config.runtime.wasm]) {
        await fs.access(path.join(nshRuntimeDir(NSH_VERSION), file));
      }
    });

    it('builds an App that also has an App.tsx beside its entry', async () => {
      // NSH takes a directory holding `App.tsx` as the app directory unless
      // the root nsh.json names the entry; then `.hatch/` is outside it and
      // no SDK import resolves.
      const { sourceDir, outputDir } = await nativeSource({
        'app/App.tsx': "export const unused = 'App.tsx is only a module';\n",
      });
      const result = await buildApp('demo', { sourceDir, outputDir });
      expect(result.normalized.app).toMatchObject({ runtime: 'native' });
      await fs.access(path.join(outputDir, 'app', 'index.html'));
    });

    it('gives the player the side modules a lazily loaded screen needs', async () => {
      // `nsh package` moves `nsh/base` parts only a chunk uses into side
      // modules; the player loads them before the chunk runs.
      const main = (await fixtureFile('app/main.tsx'))
        .replace(
          '  const go = (next: string) => {',
          [
            '  const later = signal<null | (() => unknown)>(null);',
            "  const openLater = () => import('./custom/later.tsx').then(",
            '    (module) => later.set(() => module.Later),',
            '  );',
            '  const go = (next: string) => {',
          ].join('\n'),
        )
        .replace(
          '    </Page>',
          '      <Button label="Later" onPress={() => void openLater()} />\n    </Page>',
        );
      const { sourceDir, outputDir } = await nativeSource({
        'app/main.tsx': main,
        'app/custom/later.tsx': [
          "import { Text, View } from 'nsh';",
          "import { DatePicker } from 'nsh/base';",
          'export function Later() {',
          '  return (',
          '    <View>',
          '      <Text>Later</Text>',
          '      <DatePicker value="2026-10-28" onChange={() => {}} />',
          '    </View>',
          '  );',
          '}',
          '',
        ].join('\n'),
      });
      await buildApp('demo', { sourceDir, outputDir, deploymentId: 'd-2' });
      const page = await fs.readFile(
        path.join(outputDir, 'app', 'index.html'),
        'utf8',
      );
      const config = JSON.parse(
        /<script type="application\/json" id="hatch-player">([\s\S]*?)<\/script>/.exec(
          page,
        )![1],
      ) as {
        runtime: { sides: Record<string, { url: string }> };
        app: {
          chunks: Record<string, string>;
          chunkSides: Record<string, string[]>;
        };
      };
      const [chunk, ...others] = Object.keys(config.app.chunks);
      expect(others).toEqual([]);
      await fs.access(path.join(outputDir, 'app', config.app.chunks[chunk]));
      const needed = config.app.chunkSides[chunk] ?? [];
      expect(needed.length).toBeGreaterThan(0);
      for (const name of needed) {
        const side = config.runtime.sides[name];
        expect(side).toBeDefined();
        await fs.access(path.join(nshRuntimeDir(NSH_VERSION), side.url));
      }
    });

    it('ships the images and fonts the App imports', async () => {
      // Every file `nsh package` writes must be placed (runtime, App or its
      // own page); pixel-density variants and fonts are App assets.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwAEAQH/7n8fCwAAAABJRU5ErkJggg==',
        'base64',
      );
      const ui = (await fixtureFile('app/custom/ui.tsx'))
        .replace(
          "import { mount as nshMount, signal, Scroll, Text, View } from 'nsh';",
          [
            "import { Image, mount as nshMount, signal, Scroll, Text, View } from 'nsh';",
            "import leaf from './assets/leaf.png';",
            "import Nunito from './assets/Nunito.woff2';",
          ].join('\n'),
        )
        .replace(
          '<Text class="text-2xl font-bold text-foreground">{props.title}</Text>',
          '<Image src={leaf} />\n        <Text class="text-2xl font-bold text-foreground" style={{ fontFamily: Nunito }}>\n          {props.title}\n        </Text>',
        );
      const { sourceDir, outputDir } = await nativeSource({
        'app/custom/ui.tsx': ui,
      });
      const assets = path.join(sourceDir, 'app', 'custom', 'assets');
      await fs.mkdir(assets, { recursive: true });
      await fs.writeFile(path.join(assets, 'leaf.png'), png);
      await fs.writeFile(path.join(assets, 'leaf@2x.png'), png);
      await fs.copyFile(
        path.resolve(
          'node_modules/@fontsource-variable/nunito/files/nunito-latin-wght-normal.woff2',
        ),
        path.join(assets, 'Nunito.woff2'),
      );
      await buildApp('demo', { sourceDir, outputDir, deploymentId: 'd-3' });
      const page = await fs.readFile(
        path.join(outputDir, 'app', 'index.html'),
        'utf8',
      );
      const config = JSON.parse(
        /<script type="application\/json" id="hatch-player">([\s\S]*?)<\/script>/.exec(
          page,
        )![1],
      ) as { app: { assets: Record<string, string>; fonts: string[] } };
      expect(Object.keys(config.app.assets).sort()).toEqual([
        'app/custom/assets/Nunito.woff2',
        'app/custom/assets/leaf.png',
        'app/custom/assets/leaf@2x.png',
      ]);
      expect(config.app.fonts).toEqual(['app/custom/assets/Nunito.woff2']);
      for (const file of Object.values(config.app.assets)) {
        await fs.access(path.join(outputDir, 'app', file));
      }
    });

    it('fails on a type error with its file and line', async () => {
      const main = (await fixtureFile('app/main.tsx')).replace(
        'function App() {',
        "const broken: number = 'one';\nfunction App() {",
      );
      const message = await buildError({ 'app/main.tsx': main });
      expect(message).toContain('nsh check failed');
      expect(message).toMatch(
        new RegExp(
          `(?<![\\w/])app/main\\.tsx[:(]${lineOf(main, 'const broken')}[,:]`,
        ),
      );
    });

    it('fails when App code outside app/custom imports nsh', async () => {
      const main = `import { Text } from 'nsh';\n${await fixtureFile('app/main.tsx')}`;
      const message = await buildError({ 'app/main.tsx': main });
      expect(message).toContain(
        'app/main.tsx:1: "nsh" may be imported only under app/custom/',
      );
    });

    it('fails on a bare colour in a class or a colour style', async () => {
      const ui = (await fixtureFile('app/custom/ui.tsx'))
        .replace('bg-background', 'bg-[#f5f5f5]')
        // JSX text with an apostrophe must not hide the class after it.
        .replace(
          '<Text class="text-2xl font-bold text-foreground">',
          '<Text>Don\'t wait</Text><Text class="text-2xl font-bold text-red-500/80">',
        )
        .replace(
          '<Text class="text-foreground">',
          '<Text class="text-foreground" style={{ color: \'#ff0000\' }}>',
        )
        .replace(
          '<Text class="text-primary-foreground">',
          "<Text\n        class=\"text-primary-foreground\"\n        style={{ ['backgroundColor']: '#00ff00' }}\n      >",
        );
      const message = await buildError({ 'app/custom/ui.tsx': ui });
      expect(message).toContain(
        `app/custom/ui.tsx:${lineOf(ui, 'bg-[#f5f5f5]')}: bare colour in a class`,
      );
      // A Tailwind palette class is known to NSH but follows no theme.
      expect(message).toContain(
        `app/custom/ui.tsx:${lineOf(ui, 'text-red-500/80')}: bare colour in a class`,
      );
      expect(message).toContain(
        `app/custom/ui.tsx:${lineOf(ui, "'#ff0000'")}: bare colour "#ff0000" for color`,
      );
      // A literal computed key is the same style key.
      expect(message).toContain(
        `app/custom/ui.tsx:${lineOf(ui, "'#00ff00'")}: bare colour "#00ff00" for backgroundColor`,
      );
    });

    it('fails when the native frontend calls a streaming RPC', async () => {
      const proto = (
        await fs.readFile(path.join(templateDir, 'proto/service.proto'), 'utf8')
      ).replace(
        /service CounterService \{/,
        'service CounterService {\n  rpc Watch(GetCountRequest) returns (stream CountReply);',
      );
      const main = (await fixtureFile('app/main.tsx')).replace(
        '  const go = (next: string) => {',
        [
          '  void client.watch({});',
          '  void client.watch?.({});',
          '  {',
          '    const client = { watch: () => 0 };',
          '    client.watch(); // a local object, not the RPC client',
          '  }',
          '  {',
          '    const createClient = (_: unknown) => ({ watch: () => 0 });',
          '    const local = createClient(CounterService);',
          '    local.watch(); // a local factory, not Connect',
          "    const watch = 'getCount' as const;",
          '    void client[watch]({}); // unary, whatever the key is called',
          "    const key = 'watch' as const;",
          '    void client[key]({}); // the streaming method under a const key',
          '  }',
          '  const go = (next: string) => {',
        ].join('\n'),
      );
      const message = await buildError({
        'proto/service.proto': proto,
        'app/main.tsx': main,
      });
      expect(message).toContain(
        `app/main.tsx:${lineOf(main, 'client.watch(')}: app.v1.CounterService/Watch is a server-streaming RPC`,
      );
      expect(message).toContain(
        `app/main.tsx:${lineOf(main, 'client.watch?.(')}: app.v1.CounterService/Watch`,
      );
      // Neither the Data Table's own `data.watch(...)` nor a local object
      // that shadows the client name is a call of that RPC.
      expect(message).not.toContain(
        `app/main.tsx:${lineOf(main, 'data.watch(')}:`,
      );
      expect(message).not.toContain(
        `app/main.tsx:${lineOf(main, 'client.watch(); // a local')}:`,
      );
      expect(message).not.toContain(
        `app/main.tsx:${lineOf(main, 'local.watch(); // a local factory')}:`,
      );
      expect(message).not.toContain(
        `app/main.tsx:${lineOf(main, 'void client[watch]')}:`,
      );
      expect(message).toContain(
        `app/main.tsx:${lineOf(main, 'void client[key]')}: app.v1.CounterService/Watch`,
      );
    });

    it('fails on a namespace import or export * of an nsh module', async () => {
      const ui = (await fixtureFile('app/custom/ui.tsx')).replace(
        "import { Button as BaseButton } from 'nsh/base';",
        [
          "import { Button as BaseButton } from 'nsh/base';",
          "import * as base from 'nsh/base';",
          // Type-only forms are erased before linking: not findings.
          "import type * as nshTypes from 'nsh';",
          "export type * from 'nsh/base';",
          "export { Button as ReexportedButton } from './reexport';",
          'export const baseModule = base;',
          'export type Element = nshTypes.JSX.Element;',
        ].join('\n'),
      );
      const message = await buildError({
        'app/custom/ui.tsx': ui,
        'app/custom/reexport.ts': "export * from 'nsh/base';\n",
      });
      expect(message).not.toContain(
        `app/custom/ui.tsx:${lineOf(ui, 'import type * as nshTypes')}:`,
      );
      expect(message).not.toContain(
        `app/custom/ui.tsx:${lineOf(ui, 'export type * from')}:`,
      );
      expect(message).toContain(
        `app/custom/ui.tsx:${lineOf(ui, 'import * as base')}: "nsh/base": the web player links`,
      );
      expect(message).toContain(
        'app/custom/reexport.ts:1: "nsh/base": the web player links',
      );
    });

    it('fails on a class that is not a theme token', async () => {
      const ui = (await fixtureFile('app/custom/ui.tsx')).replace(
        'text-2xl font-bold text-foreground',
        'text-2xl font-bold text-brand-550',
      );
      const message = await buildError({ 'app/custom/ui.tsx': ui });
      expect(message).toContain('unknown classes are not theme tokens');
      expect(message).toMatch(
        new RegExp(
          `app/custom/ui\\.tsx:${lineOf(ui, 'text-brand-550')}:\\d+: unknown class \`text-brand-550\``,
        ),
      );
    });

    it('fails when the App throws while starting', async () => {
      const main = (await fixtureFile('app/main.tsx')).replace(
        '  show(route());',
        "  show(route());\n  if (route()) throw new Error('fixture start-up failure');",
      );
      const message = await buildError({ 'app/main.tsx': main });
      expect(message).toContain('Start-up check (nsh test) failed');
      expect(message).toContain('fixture start-up failure');
      expect(message).toContain(
        `app/main.tsx:${lineOf(main, "throw new Error('fixture")}:`,
      );
    });

    it('refuses an authored nsh.json that would set its own grant', async () => {
      const message = await buildError({
        'app/nsh.json': JSON.stringify({ capabilities: { network: true } }),
      });
      expect(message).toContain(
        'the platform generates nsh.json at the App root; remove app/nsh.json',
      );
    });

    it('runs the start-up check without network access to the instance', async () => {
      const requests: string[] = [];
      const server = http.createServer((request, response) => {
        requests.push(request.url ?? '');
        response.end('reached');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      try {
        const { port } = server.address() as net.AddressInfo;
        const main = (await fixtureFile('app/main.tsx')).replace(
          '  show(route());',
          `  show(route());\n  void fetch('http://127.0.0.1:${port}/escape').then(\n    () => error.set('reached'),\n    (cause: unknown) => console.log('request denied:', String(cause)),\n  );`,
        );
        const { sourceDir, outputDir } = await nativeSource({
          'app/main.tsx': main,
        });
        const result = await buildApp('demo', { sourceDir, outputDir });
        expect(result.log).toContain('$ nsh test app/main.tsx');
        // The App saw its request refused (a pending one would not count).
        expect(result.log).toMatch(/request denied:.*is not granted/);
        expect(requests).toEqual([]);
      } finally {
        server.close();
      }
    });
  },
);
