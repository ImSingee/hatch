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

// App views embed `/app/<slug>/embed/`. Serve a blank same-origin document
// there so the iframe never boots the Browser Mode runner page instead.
function appEmbedFixture(): Plugin {
  return {
    name: 'app-embed-test-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/^\/app\/[^/]+\/embed\//.test(req.url ?? '')) return next();
        res.setHeader('Content-Type', 'text/html');
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
