/**
 * The NSH configuration the platform generates for a native App: the root
 * `nsh.json` and `app/tsconfig.json`. Deploys write both into the build
 * copy; the SDK delivers the App-independent part (`nativeNshBase`,
 * `nativeEntryTsconfig`) so the `hatch` CLI writes the same files into a
 * checkout, where the Agent runs `nsh check`, `nsh test` and `nsh build`.
 */
import {
  NATIVE_APP_SDK_DEFINITIONS,
  sdkImports,
} from '../../../../sdk-internal/definitions';
import { composeNativeNshJson } from '../../../app-native-config';
import { DEFAULT_ACCENT } from '../../../ui/theme/accents';
import { nshTailwind, nshTheme } from './nsh-theme';

export { nshAppId } from '../../../app-native-config';

/**
 * Host calls a native App is granted on every shell, and nothing else: no
 * network, files, clipboard or URL access. Granted native capabilities add
 * their `hatch.native.<id>.*` names (a later phase).
 */
export const NATIVE_HOST_CALLS = [
  'hatch.rpc',
  'hatch.data.query',
  'hatch.data.mutate',
  'hatch.data.events',
  'hatch.theme.get',
  'hatch.nav.setTitle',
  'hatch.nav.setRoute',
  'hatch.nav.open',
  'hatch.native.supports',
] as const;

/** The grant a shell hands NSH for an App, as the JSON text NSH reads. */
export function nativeGrant(): string {
  return JSON.stringify({ host: [...NATIVE_HOST_CALLS] });
}

/** Exact `nsh.json` aliases: one per entry of every native SDK, App-root relative. */
export function nativeSdkAliases(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sdkImports(NATIVE_APP_SDK_DEFINITIONS, 'native')).map(
      ([specifier, target]) => [specifier, `./.hatch/${target.slice(2)}`],
    ),
  );
}

/** Every key of the root `nsh.json` that is the same for all Apps. */
export function nativeNshBase(): Record<string, unknown> {
  return {
    version: '1.0.0',
    build: 1,
    // Declared capabilities deny everything not listed.
    capabilities: { host: [...NATIVE_HOST_CALLS] },
    resolve: { alias: nativeSdkAliases() },
    // Hatch is light-only until the theme-data phase adds dark presets.
    appearance: 'light',
    theme: nshTheme(DEFAULT_ACCENT),
    ...(nshTailwind() ? { tailwind: nshTailwind() } : {}),
  };
}

/** The platform-generated `nsh.json` at the App root. */
export function nativeNshJson(app: {
  id: string;
  name: string;
  entry: string;
}): string {
  return composeNativeNshJson(app, nativeNshBase());
}

/** The platform-generated `app/tsconfig.json` next to the entry. */
export function nativeEntryTsconfig(): string {
  const paths: Record<string, string[]> = {
    nsh: ['./.nsh/types/nsh/index.d.ts'],
    'nsh/*': ['./.nsh/types/nsh/*.d.ts'],
  };
  for (const [specifier, target] of Object.entries(nativeSdkAliases())) {
    // `.js` targets resolve to their sibling declarations; source entries
    // (`.ts`/`.tsx` libraries) are checked as they are.
    paths[specifier] = [`.${target.replace(/\.js$/, '')}`];
  }
  return `${JSON.stringify(
    {
      extends: './.nsh/tsconfig.json',
      // `resolveJsonModule`: `@hatch/ui` imports its built-in theme JSON.
      compilerOptions: {
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        paths,
      },
      include: ['**/*.ts', '**/*.tsx', '../gen/**/*.ts'],
      exclude: ['./.nsh'],
    },
    null,
    2,
  )}\n`;
}
