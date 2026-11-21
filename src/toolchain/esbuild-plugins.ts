/** esbuild plugins shared by browser bundles and Node-toolchain runtime bundles. */
import { constants as fsConstants, promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as esbuild from 'esbuild';
import { APP_HATCH_SDK_IMPORTS } from '~agent/hatch-sdk';

/** Resolve only the public, platform-owned Hatch SDK entrypoints. */
export function hatchSdkPlugin(
  src: string,
  imports: Readonly<Record<string, string>> = APP_HATCH_SDK_IMPORTS,
): esbuild.Plugin {
  const entries = new Map(
    Object.entries(imports).map(([specifier, target]) => [
      specifier,
      path.resolve(src, '.hatch', target),
    ]),
  );
  // Legacy @hatch/data aliases still resolve but are not suggested.
  const suggested = [...entries.keys()]
    .filter((specifier) => !/^@hatch\/data(?:\/|$)/.test(specifier))
    .join(', ');
  return {
    name: 'hatch-sdk',
    setup(build) {
      build.onResolve({ filter: /^@hatch(?:\/|$)/ }, (args) => {
        const resolved = entries.get(args.path);
        if (resolved) return { path: resolved };
        return {
          errors: [
            {
              text:
                `Unknown Hatch SDK import "${args.path}". ` +
                `Use one of: ${suggested}.`,
            },
          ],
        };
      });
    },
  };
}

export function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function browserLoaderForPath(target: string): esbuild.Loader | undefined {
  switch (path.extname(target).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.json':
      return 'json';
    case '.css':
      return 'css';
    case '.txt':
      return 'text';
    default:
      return undefined;
  }
}

function directBrowserLocalPath(
  specifier: string,
  resolveDir: string,
): { path: string; suffix?: string } | null {
  if (specifier.startsWith('file:')) {
    let url: URL;
    try {
      url = new URL(specifier);
      if (url.protocol !== 'file:') return null;
      const suffix = `${url.search}${url.hash}` || undefined;
      url.search = '';
      url.hash = '';
      return { path: fileURLToPath(url), suffix };
    } catch {
      return { path: specifier };
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('\\\\')) {
    return { path: specifier };
  }
  if (path.isAbsolute(specifier)) return { path: specifier };
  if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    return { path: path.resolve(resolveDir, specifier) };
  }
  return null;
}

/**
 * Defense in depth for esbuild's separate resolver. Every browser module is
 * canonicalized before its bytes are returned to esbuild, including package
 * files reached through node_modules links. Installed dependencies and the
 * managed .hatch SDK remain valid because both live below the temporary source
 * root; platform-repository fallback modules do not.
 */
export function sourceBoundaryPlugin(
  sourceRoot: string,
  subject = 'Browser',
  rootLabel = 'App source root',
): esbuild.Plugin {
  return {
    name: 'app-source-boundary',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const local = directBrowserLocalPath(args.path, args.resolveDir);
        if (!local) return undefined;
        const absolute = path.resolve(local.path);
        if (!pathIsInside(sourceRoot, absolute)) {
          return {
            errors: [
              {
                text:
                  `${subject} import "${args.path}" must stay inside the ` +
                  `${rootLabel}.`,
              },
            ],
          };
        }
        // esbuild does not resolve file: URLs itself. Other local forms can use
        // its normal extension/package metadata handling before onLoad applies
        // the canonical check below.
        if (args.path.startsWith('file:')) return local;
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        let canonical: string;
        try {
          canonical = await fs.realpath(args.path);
        } catch (error) {
          return {
            errors: [
              {
                text:
                  `${subject} module "${args.path}" could not be verified: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
        if (!pathIsInside(sourceRoot, canonical)) {
          return {
            errors: [
              {
                text:
                  `${subject} module "${args.path}" resolves outside the ` +
                  `${rootLabel}.`,
              },
            ],
          };
        }

        const loader = browserLoaderForPath(canonical);
        if (!loader) return undefined;
        let handle;
        try {
          handle = await fs.open(
            canonical,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          if (!(await handle.stat()).isFile()) {
            return {
              errors: [
                {
                  text: `${subject} module is not a regular file: ${args.path}`,
                },
              ],
            };
          }
          return {
            contents: await handle.readFile(),
            loader,
            resolveDir: path.dirname(canonical),
          };
        } catch (error) {
          return {
            errors: [
              {
                text:
                  `${subject} module "${args.path}" could not be read safely: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        } finally {
          await handle?.close();
        }
      });
    },
  };
}

const NODE_BUILTINS = new Set(
  builtinModules.filter((name) => !name.startsWith('_')),
);

/**
 * Leave Node built-ins external under their `node:` name, the only spelling
 * Deno resolves without npm or an import map. Every other URL-like specifier
 * is rejected: a runtime bundle carries its dependencies with it.
 */
export function nodeBuiltinsPlugin(): esbuild.Plugin {
  return {
    name: 'node-builtins',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const name = args.path.startsWith('node:')
          ? args.path.slice('node:'.length)
          : args.path;
        if (NODE_BUILTINS.has(name)) {
          return { path: `node:${name}`, external: true };
        }
        if (
          /^[a-z][a-z\d+.-]*:/i.test(args.path) &&
          !/^[A-Za-z]:[\\/]/.test(args.path) &&
          !args.path.startsWith('file:')
        ) {
          return {
            errors: [
              {
                text:
                  `Unsupported import "${args.path}". Declare npm ` +
                  'dependencies in package.json and import them by package ' +
                  'name; remote, npm: and jsr: specifiers are not supported.',
              },
            ],
          };
        }
        return undefined;
      });
    },
  };
}
