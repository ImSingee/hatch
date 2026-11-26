import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import viteReact from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const DEFAULT_COUNTER_TEMPLATE_ID = 'virtual:default-counter-template';
const DEFAULT_COUNTER_FIXTURE_ID = '\0default-counter-template-test-fixture';
const DEFAULT_COUNTER_TEMPLATE_PATH = fileURLToPath(
  new URL('./templates/default-app/widgets/counter.tsx', import.meta.url),
);
// `nsh` exists only inside the NSH runtime; unit tests of the native SDK
// entries resolve it to a stub they mock.
const NSH_MODULE_STUB_PATH = fileURLToPath(
  new URL(
    './src/server/apps/native/test-fixtures/nsh-module.ts',
    import.meta.url,
  ),
);

function defaultCounterTemplateFixture(): Plugin {
  const isDefaultCounterTemplate = (importer: string | undefined) =>
    importer
      ?.split('?')[0]
      .endsWith('/templates/default-app/widgets/counter.tsx') ?? false;

  return {
    name: 'default-counter-template-test-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === DEFAULT_COUNTER_TEMPLATE_ID) {
        return DEFAULT_COUNTER_TEMPLATE_PATH;
      }
      if (!isDefaultCounterTemplate(importer)) return;
      if (
        source === '../gen/service_pb.ts' ||
        source === '@connectrpc/connect' ||
        source === '@connectrpc/connect-web'
      ) {
        return DEFAULT_COUNTER_FIXTURE_ID;
      }
    },
    load(id) {
      if (id !== DEFAULT_COUNTER_FIXTURE_ID) return;
      return `
        export const CounterService = {};
        export const createConnectTransport = () => ({});
        export const createClient = () =>
          globalThis.__defaultCounterTemplateRpcClient;
      `;
    },
  };
}

const NATIVE_PLAYER_FIXTURE = `<!doctype html>
<meta name="hatch-app-runtime" content="native">
<title>Native player</title>
<script>
  window.received = [];
  addEventListener('message', (event) => {
    if (event.data?.protocol !== 'hatch.app-surface/1' || !event.ports[0]) return;
    const port = event.ports[0];
    window.surfacePort = port;
    port.onmessage = (message) => {
      window.received.push(message.data);
      if (message.data.type === 'init') {
        port.postMessage({ type: 'hello', appId: 'native-app', deploymentId: 'd1' });
        port.postMessage({ type: 'title', title: 'Native home' });
        port.postMessage({ type: 'route', route: message.data.route });
      }
      if (message.data.type === 'navigate') {
        port.postMessage({ type: 'route', route: message.data.route });
      }
    };
  });
</script>`;

// A `web` App that watches a Data Table with the real SDK, so a test drives
// the App's own reconnect loop. Its first script asks for a change stream
// while the page is still parsing, before any `load`.
const dataAppFixture = (slug: string) => `<!doctype html>
<title>Data app</title>
<script>
  window.earlyEnded = false;
  fetch('/api/app/${slug}/data/events?since=0&table=early').then(async (response) => {
    const reader = response.body.getReader();
    while (!(await reader.read()).done) {}
    window.earlyEnded = true;
  });
</script>
<script type="module">
  import { createDataClient } from '/sdk-internal/app/src/data.ts';
  window.snapshots = [];
  window.errors = [];
  createDataClient({ baseUrl: '/api/app/${slug}/data' }).watch(
    { table: 'notes' },
    (result) => window.snapshots.push(result.revision),
    (error) => window.errors.push(String(error)),
  );
</script>`;

type DataStream = { table: string; send: (chunk: string) => void };
type DataFixtureState = {
  revision: number;
  streams: Set<DataStream>;
  /** The `since` of every `notes` stream opened, in order. */
  sinces: number[];
};

/**
 * The Data API of `web-data-*` Apps: `query` answers the current revision,
 * `events` streams changes (replaying any after `since`), and
 * `/__fixture/data/<slug>` reports (GET), makes a change (POST `change`) or
 * starts over (POST `reset`).
 */
function dataApiFixture(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  states: Map<string, DataFixtureState>,
) {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  const fixture = url.pathname.match(/^\/__fixture\/data\/([^/]+)\/?(\w*)$/);
  const api = url.pathname.match(
    /^\/api\/app\/(web-data-[^/]+)\/data\/(query|events)$/,
  );
  const slug = fixture?.[1] ?? api?.[1];
  if (!slug) return false;
  let state = states.get(slug);
  if (!state || fixture?.[2] === 'reset') {
    for (const stream of state?.streams ?? []) stream.send('');
    state = { revision: 0, streams: new Set(), sinces: [] };
    states.set(slug, state);
  }
  const json = (value: unknown) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (fixture) {
    if (fixture[2] === 'change') {
      state.revision += 1;
      for (const stream of state.streams) {
        if (stream.table === 'notes') {
          stream.send(`id: ${state.revision}\nevent: change\ndata: {}\n\n`);
        }
      }
    }
    json({
      revision: state.revision,
      open: [...state.streams].map((stream) => stream.table),
      sinces: state.sinces,
    });
    return true;
  }
  if (api?.[2] === 'query') {
    json({ items: [], revision: state.revision });
    return true;
  }
  const table = url.searchParams.get('table') ?? '';
  const since = Number(url.searchParams.get('since') ?? 0);
  if (table === 'notes') state.sinces.push(since);
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  const current = state;
  const stream: DataStream = {
    table,
    send: (chunk) => {
      if (chunk) res.write(chunk);
      else res.end();
    },
  };
  current.streams.add(stream);
  req.on('close', () => current.streams.delete(stream));
  res.write(': connected\n\n');
  if (table === 'notes' && since < current.revision) {
    res.write(`id: ${current.revision}\nevent: change\ndata: {}\n\n`);
  }
  return true;
}

// App views embed `/app/<slug>/embed/`. Serve a blank same-origin document
// there so the iframe never boots the Browser Mode runner page instead.
function appEmbedFixture(): Plugin {
  const dataStates = new Map<string, DataFixtureState>();
  return {
    name: 'app-embed-test-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (dataApiFixture(req, res, dataStates)) return;
        if (!/^\/app\/[^/]+\/embed\//.test(req.url ?? '')) return next();
        res.setHeader('Content-Type', 'text/html');
        const dataApp = req.url?.match(/^\/app\/(web-data-[^/]+)\/embed\//);
        if (dataApp) {
          res.end(dataAppFixture(dataApp[1]));
          return;
        }
        // `native-*` slugs get a stand-in for the native player page: it
        // records what the surface sends and answers like the player.
        if (/^\/app\/native-[^/]+\/embed\//.test(req.url ?? '')) {
          res.end(NATIVE_PLAYER_FIXTURE);
          return;
        }
        res.end('<!doctype html><title>Embedded app</title>');
      });
    },
  };
}

export default defineConfig({
  test: {
    maxWorkers: 2,
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          tsconfigPaths: true,
          alias: { nsh: NSH_MODULE_STUB_PATH },
        },
        test: {
          name: 'unit',
          environment: 'node',
          env: {
            // Runner code resolves its env snapshot when no OS sandbox is
            // available (e.g. Linux without root), which requires APP_URL.
            APP_URL: 'http://localhost:3700',
          },
          include: [
            'src/**/*.{test,spec}.{ts,tsx}',
            'packages/hatch-cli/src/**/*.{test,spec}.ts',
            'packages/hatch-platform-api/*.test.ts',
            'mobile/src/core/**/*.test.ts',
            'scripts/**/*.test.ts',
            'sdk-internal/ui/test/**/*.test.ts',
          ],
          exclude: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
        },
      },
      {
        define: {
          __RPC_BASE_URL__: JSON.stringify('/test-rpc'),
        },
        resolve: {
          tsconfigPaths: true,
        },
        server: {
          // Skip warming server-backed modules that browser tests mock.
          preTransformRequests: false,
        },
        optimizeDeps: {
          exclude: ['@tanstack/react-start', '@tanstack/react-start/server'],
          // The Composer imports these entry points directly. Prebundle
          // them before Browser Mode starts so Vite never reloads the page
          // mid-test when it discovers a lazily rendered Composer.
          include: [
            '@floating-ui/dom',
            '@tiptap/pm/history',
            '@tiptap/pm/state',
            '@tiptap/suggestion',
          ],
        },
        plugins: [
          appEmbedFixture(),
          defaultCounterTemplateFixture(),
          viteReact(),
        ],
        test: {
          name: 'browser',
          globals: true,
          setupFiles: ['./vitest.browser.setup.ts'],
          include: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
          deps: {
            optimizer: {
              client: {
                enabled: false,
              },
            },
          },
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            headless: true,
            viewport: {
              width: 1280,
              height: 720,
            },
            screenshotFailures: true,
          },
        },
      },
    ],
  },
});
