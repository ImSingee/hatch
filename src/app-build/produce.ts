/**
 * Build App source into a build package (./format.ts). This runs authored
 * code (dependency installs, manifest and schema evaluation, type checks,
 * bundlers, the native start-up check), so it runs only where that is
 * acceptable: the dedicated Builder or the author's own CLI. The platform
 * accepts the package without running any of it.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { NODE_TOOLCHAIN_IGNORED_ROOT_FILE } from '../app-managed-path';
import { assertNoBundleImports } from '../node-toolchain-commands';
import { PLATFORM_APP_BUF_GEN_YAML } from '../agent/app-codegen';
import { detectSourceManifest, loadSourceManifest } from '../source-manifest';
import {
  detectSourceToolchain,
  sourceToolchainReader,
  type SourceToolchain,
} from '../source-toolchain';
import { createSourceToolchain } from '../toolchain';
import {
  hatchSdkPlugin,
  sourceBoundaryPlugin,
} from '../toolchain/esbuild-plugins';
import {
  dataTableUrl,
  parseSourceManifest,
  rpcUrl,
  type SourceManifest,
} from '../server/apps/manifest';
import { manifestInvalid } from '../server/apps/manifest-validation';
import {
  APP_DOC_MAX_BYTES,
  APP_DOCS_MAX_TOTAL_BYTES,
} from '../server/apps/docs-build';
import {
  BUILD_PACKAGE_API_DESCRIPTOR,
  BUILD_PACKAGE_DOCS_DIR,
  BUILD_PACKAGE_FORMAT,
  BUILD_PACKAGE_MANIFEST,
  BUILD_PACKAGE_PROTO_DIR,
  type BuildPackageManifest,
} from './format';
import { readAppApi } from './api';
import type { BuildHost } from './host';
import { buildNativeFrontend } from './native';

export type BuildAppSourceOptions = {
  appId: string;
  /** The deployment the package is built for; baked into browser bundles. */
  deploymentId: string;
  /** The source commit, when the source came from the App repository. */
  commit: string | null;
  /** The source tree (a clean checkout or export). Not modified. */
  sourceDir: string;
  /** Where the package is written; must not exist yet. */
  outDir: string;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a directory this build owns. A failure is logged, never thrown: it
 * must not replace the build's own result or error.
 */
async function removeOwned(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
    console.error(`[app-build] could not remove ${dir}:`, error);
  });
}

/** The runtime entry a backend source entry is bundled to. */
export function backendBundleEntry(sourceEntry: string): string {
  const normalized = sourceEntry.replaceAll('\\', '/');
  const extension = path.posix.extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  return `${stem}.bundle.js`;
}

async function copyBackendAssetNode(
  source: string,
  destination: string,
  relativePath: string,
): Promise<void> {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(`backend asset disappeared during build: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyBackendAssetNode(
        path.join(source, entry),
        path.join(destination, entry),
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend asset must be a regular file or directory: ${relativePath}`,
    );
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyBackendAssets(
  sourceRoot: string,
  outputRoot: string,
): Promise<void> {
  const backendPath = 'backend';
  const backendSource = path.join(sourceRoot, backendPath);
  const backendStat = await fs.lstat(backendSource).catch(() => null);
  if (backendStat?.isSymbolicLink()) {
    throw new Error(
      `backend source directory must not be a symbolic link: ${backendPath}`,
    );
  }
  if (backendStat && !backendStat.isDirectory()) {
    throw new Error(`backend source path must be a directory: ${backendPath}`);
  }

  const relativePath = 'backend/assets';
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);

  // The runtime contract always points at this directory, including for apps
  // that do not ship static files.
  await fs.mkdir(destination, { recursive: true });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset directory must not be a symbolic link: ${relativePath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`backend asset path must be a directory: ${relativePath}`);
  }
  for (const entry of await fs.readdir(source)) {
    await copyBackendAssetNode(
      path.join(source, entry),
      path.join(destination, entry),
      path.posix.join(relativePath, entry),
    );
  }
}

async function validateBackendBundleSourceNode(
  sourceRoot: string,
  relativePath: string,
): Promise<void> {
  // Assets have their own stricter copy-time walk and diagnostics below.
  if (
    relativePath === 'backend/assets' ||
    relativePath.startsWith('backend/assets/')
  ) {
    return;
  }

  const source = path.join(sourceRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(
      `backend bundle source disappeared during build: ${relativePath}`,
    );
  }
  if (stat.isSymbolicLink()) {
    if (relativePath === 'backend') {
      throw new Error(
        'backend source directory must not be a symbolic link: backend',
      );
    }
    throw new Error(
      `backend bundle source must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await validateBackendBundleSourceNode(
        sourceRoot,
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend bundle source must be a regular file or directory: ${relativePath}`,
    );
  }
}

async function validateBackendBundleSourceTree(
  sourceRoot: string,
): Promise<void> {
  // Check the platform-defined backend/generated roots. Installed packages
  // legitimately contain package-manager links, and unrelated app content
  // should not be rejected merely because the app also has a backend.
  for (const root of ['backend', 'gen']) {
    const stat = await fs.lstat(path.join(sourceRoot, root)).catch(() => null);
    if (stat) await validateBackendBundleSourceNode(sourceRoot, root);
  }
}

/**
 * Source trees are untrusted. The builder overwrites platform-managed files and
 * invokes tools inside its temporary copy, so even one preserved symlink could
 * redirect a write/read outside that copy. Validate the copied tree before the
 * first manifest read or generated-file write and never recurse through links.
 */
async function assertSourceHasNoSymlinks(root: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error('App source may not contain symbolic links: .');
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if (relative === 'backend') {
          throw new Error(
            'backend source directory must not be a symbolic link: backend',
          );
        }
        if (relative === 'backend/assets') {
          throw new Error(
            'backend asset directory must not be a symbolic link: backend/assets',
          );
        }
        if (relative.startsWith('backend/assets/')) {
          throw new Error(
            `backend asset must not be a symbolic link: ${relative}`,
          );
        }
        if (
          relative.startsWith('backend/') ||
          relative === 'gen' ||
          relative.startsWith('gen/')
        ) {
          throw new Error(
            `backend bundle source must not be a symbolic link: ${relative}`,
          );
        }
        throw new Error(
          `App source may not contain symbolic links: ${relative}`,
        );
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(root);
}

type SourceCheckEntry = {
  path: string;
  missingMessage: string;
};

/**
 * Return the authored TypeScript roots enabled by the source manifest. Deno
 * follows every transitive import from these roots, so one invocation checks
 * the complete App graph while avoiding disabled capabilities.
 */
function sourceCheckEntries(manifest: SourceManifest): SourceCheckEntry[] {
  const entries: SourceCheckEntry[] = [];
  // A native frontend is NSH TSX, checked by `nsh check` in its own step.
  if (
    manifest.capabilities.frontend &&
    manifest.app &&
    manifest.app.runtime !== 'native'
  ) {
    entries.push({
      path: manifest.app.entry,
      missingMessage: `app entry not found: ${manifest.app.entry}`,
    });
  }
  if (manifest.capabilities.backend && manifest.backend) {
    entries.push({
      path: manifest.backend.entry,
      missingMessage: `backend entry not found: ${manifest.backend.entry}`,
    });
  }
  if (manifest.capabilities.widgets) {
    for (const widget of manifest.widgets) {
      entries.push({
        path: widget.entry,
        missingMessage: `widget entry not found: ${widget.entry}`,
      });
    }
  }
  if (manifest.capabilities.dataTable) {
    entries.push({
      path: 'data/schema.ts',
      missingMessage:
        'capabilities.dataTable is true but data/schema.ts does not exist.',
    });
  }

  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

/** Type-check every enabled App entry before evaluating or bundling source. */
async function checkAppSource(
  src: string,
  manifest: SourceManifest,
  toolchain: SourceToolchain,
): Promise<void> {
  if (
    manifest.capabilities.frontend &&
    manifest.app?.runtime === 'native' &&
    !(await pathExists(path.join(src, manifest.app.entry)))
  ) {
    throw new Error(
      `Source validation failed: app entry not found: ${manifest.app.entry}`,
    );
  }
  const entries = sourceCheckEntries(manifest);
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (!(await pathExists(path.join(src, entry.path)))) {
      throw new Error(`Source validation failed: ${entry.missingMessage}`);
    }
  }

  const backend = manifest.backend;
  const validatesFetchBackend =
    backend?.runtime === 'deno-serve' &&
    manifest.capabilities.backend &&
    backend !== undefined;
  await toolchain.check({
    entries: entries.map((entry) => entry.path),
    fetchContract: validatesFetchBackend ? backend.entry : undefined,
  });
}

/** Copy every `.proto` under the App's fixed `proto/` directory. */
async function copyProtoFiles(src: string, out: string): Promise<number> {
  const protoRoot = path.join(src, 'proto');
  if (!(await pathExists(protoRoot))) return 0;
  let count = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.proto')) {
        const relative = path.relative(protoRoot, full);
        const target = path.join(out, BUILD_PACKAGE_PROTO_DIR, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(full, target);
        count += 1;
      }
    }
  }
  await walk(protoRoot);
  return count;
}

/**
 * Copy the files the manifest declares as docs. The platform reads and
 * checks them (size, UTF-8, digest) when it accepts the package.
 */
/**
 * Copy the declared docs into the package. The platform checks them again,
 * but a doc over the limits fails here, before the App is bundled and the
 * package uploaded.
 */
async function copyDeclaredDocs(
  src: string,
  out: string,
  docs: SourceManifest['docs'],
): Promise<void> {
  let total = 0;
  for (const [index, entry] of docs.entries()) {
    const relative = path.posix.normalize(entry.path);
    if (relative.startsWith('../') || path.posix.isAbsolute(relative)) {
      // The platform reports the declaration; the file is not copied.
      continue;
    }
    const source = path.join(src, relative);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    if (stat.size > APP_DOC_MAX_BYTES) {
      throw manifestInvalid(
        ['docs', index, 'path'],
        `${entry.path} is ${stat.size} bytes; the limit is ${APP_DOC_MAX_BYTES} bytes.`,
      );
    }
    total += stat.size;
    if (total > APP_DOCS_MAX_TOTAL_BYTES) {
      throw manifestInvalid(
        ['docs'],
        `The declared docs exceed ${APP_DOCS_MAX_TOTAL_BYTES} bytes in total.`,
      );
    }
    const target = path.join(out, BUILD_PACKAGE_DOCS_DIR, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

/** Shared esbuild define for browser bundles (app + widgets). */
function browserDefine(
  id: string,
  name: string,
  deploymentId: string,
): Record<string, string> {
  return {
    __RPC_BASE_URL__: JSON.stringify(rpcUrl(id)),
    __DATA_BASE_URL__: JSON.stringify(dataTableUrl(id)),
    __DATA_DEPLOYMENT_ID__: JSON.stringify(deploymentId),
    __APP_NAME__: JSON.stringify(name),
    'process.env.NODE_ENV': '"production"',
  };
}

/**
 * A classic script that scopes `localStorage` and `sessionStorage` to this App
 * before any App or library code runs (see @hatch/app/storage/install). Keyed
 * by the immutable id so renaming the slug keeps users' stored values.
 */
async function storageInstallScript(
  id: string,
  esbuildResolve: Pick<esbuild.BuildOptions, 'absWorkingDir' | 'plugins'>,
): Promise<string> {
  const result = await esbuild.build({
    ...esbuildResolve,
    stdin: {
      contents:
        "import { installAppStorage } from '@hatch/app/storage/install';\n" +
        `installAppStorage(${JSON.stringify(id)});\n`,
      resolveDir: esbuildResolve.absWorkingDir,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** Elements whose contents the browser reads as text up to their end tag. */
const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

/** The `src` values that name the SPA bundle next to the page. */
const BUNDLE_SRC = new Set(['app.js', './app.js', '/app.js']);

/**
 * Where page code can go in authored HTML, from one scan of its tags as the
 * browser tokenizes them: comments, raw-text element contents and quoted
 * attribute values are never read as tags, and nothing inside a
 * `<template>` (inert content) counts. Offsets index into the scanned text.
 */
type HtmlPlaces = {
  /** Just after the first `<head>` start tag. */
  headStart: number | null;
  /** The start of the first `<script>` element. */
  firstScript: number | null;
  /** The first `<script src="app.js">` element, through its end tag. */
  bundleScript: { start: number; end: number } | null;
  /** The start of the first `</body>`, and of the first `</html>`. */
  bodyEnd: number | null;
  htmlEnd: number | null;
  /** Whether the text ends inside a comment, tag or raw-text element. */
  openAtEnd: boolean;
};

function scanHtml(html: string): HtmlPlaces {
  const places: HtmlPlaces = {
    headStart: null,
    firstScript: null,
    bundleScript: null,
    bodyEnd: null,
    htmlEnd: null,
    openAtEnd: false,
  };
  const space = /[\t\n\f\r ]/;
  /** The index just past the next match of `pattern` from `from`, or -1. */
  const past = (pattern: RegExp, from: number) => {
    const sticky = new RegExp(pattern.source, `${pattern.flags}g`);
    sticky.lastIndex = from;
    const match = sticky.exec(html);
    return match ? match.index + match[0].length : -1;
  };
  let templates = 0;
  let index = 0;
  for (;;) {
    const open = html.indexOf('<', index);
    if (open === -1) return places;
    if (html.startsWith('<!--', open)) {
      // `<!-->` and `<!--->` are whole (empty) comments.
      const end = /^-?>/.exec(html.slice(open + 4, open + 6))
        ? html.indexOf('>', open + 4) + 1
        : past(/--!?>/, open + 4);
      if (end === -1) return { ...places, openAtEnd: true };
      index = end;
      continue;
    }
    const closing = html[open + 1] === '/';
    const nameStart = open + (closing ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? '')) {
      if (closing || html[open + 1] === '!' || html[open + 1] === '?') {
        // `<!doctype>`, `<?…>` and `</…>` without a name end at the next `>`.
        const end = html.indexOf('>', open + 1);
        if (end === -1) return { ...places, openAtEnd: true };
        index = end + 1;
      } else {
        index = open + 1; // A `<` in text.
      }
      continue;
    }
    let cursor = nameStart;
    while (cursor < html.length && !/[\t\n\f\r />]/.test(html[cursor])) {
      cursor += 1;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();
    // Attributes, with the first of a repeated name winning, as in the DOM.
    const attributes = new Map<string, string>();
    let tagEnd = -1;
    while (cursor < html.length) {
      const char = html[cursor];
      if (char === '>') {
        tagEnd = cursor + 1;
        break;
      }
      if (space.test(char) || char === '/') {
        cursor += 1;
        continue;
      }
      const attributeStart = cursor;
      cursor += 1; // A leading `=` belongs to the name.
      while (cursor < html.length && !/[\t\n\f\r />=]/.test(html[cursor])) {
        cursor += 1;
      }
      const attribute = html.slice(attributeStart, cursor).toLowerCase();
      while (cursor < html.length && space.test(html[cursor])) cursor += 1;
      let value = '';
      if (html[cursor] === '=') {
        cursor += 1;
        while (cursor < html.length && space.test(html[cursor])) cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          if (end === -1) return { ...places, openAtEnd: true };
          value = html.slice(cursor + 1, end);
          cursor = end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < html.length && !/[\t\n\f\r >]/.test(html[cursor])) {
            cursor += 1;
          }
          value = html.slice(valueStart, cursor);
        }
      }
      if (!attributes.has(attribute)) attributes.set(attribute, value);
    }
    if (tagEnd === -1) return { ...places, openAtEnd: true };
    index = tagEnd;

    if (closing) {
      if (name === 'template') templates = Math.max(0, templates - 1);
      else if (templates === 0 && name === 'body') places.bodyEnd ??= open;
      else if (templates === 0 && name === 'html') places.htmlEnd ??= open;
      continue;
    }
    if (name === 'template') templates += 1;
    if (templates === 0 && name === 'head') places.headStart ??= tagEnd;
    if (templates === 0 && name === 'script') places.firstScript ??= open;
    if (!RAW_TEXT_ELEMENTS.has(name)) continue;
    // `plaintext` has no end tag: the rest of the document is its text.
    const close =
      name === 'plaintext'
        ? -1
        : past(new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'i'), tagEnd);
    const end = close === -1 ? -1 : html.indexOf('>', close - 1) + 1;
    if (end <= 0) return { ...places, openAtEnd: true };
    if (
      name === 'script' &&
      templates === 0 &&
      !places.bundleScript &&
      BUNDLE_SRC.has(attributes.get('src')?.trim() ?? '')
    ) {
      places.bundleScript = { start: open, end };
    }
    index = end;
  }
}

/**
 * `code` as the body of an inline script element: `<\/` reads as `</` in a
 * string, template or regular expression, and keeps the tag name's case.
 */
function scriptBody(code: string): string {
  return code.replace(/<\/(script)/gi, (_match, name: string) => `<\\/${name}`);
}

/**
 * The App page: the authored HTML with the storage installer as a classic
 * script before every page script, and the bundle as a live module script
 * in place of the authored `<script src="app.js">`, or at the end of the
 * body without one. Both places come from the authored markup, so markup in
 * the bundle is never matched.
 */
export function composeAppHtml(
  authored: string,
  installer: string,
  bundle: string,
  htmlFile: string,
): string {
  const places = scanHtml(authored);
  const end = places.bodyEnd ?? places.htmlEnd ?? authored.length;
  // Appended text would land in whatever the document leaves open.
  if (!places.bundleScript && end === authored.length && places.openAtEnd) {
    throw new Error(
      `${htmlFile} ends inside an unclosed comment, tag or element, so the ` +
        'App bundle cannot be added to it.',
    );
  }
  // An implied head starts at the first script; an explicit one may come
  // later (the browser then ignores the tag), so the earlier place wins.
  const candidates = [places.headStart, places.firstScript].filter(
    (place) => place !== null,
  );
  const bundlePlace = places.bundleScript ?? { start: end, end };
  const installerAt = candidates.length
    ? Math.min(...candidates)
    : bundlePlace.start;
  const installerTag = installer
    ? `<script>${scriptBody(installer)}</script>`
    : '';
  const bundleTag = `<script type="module">${scriptBody(bundle)}</script>${
    places.bundleScript ? '' : '\n'
  }`;
  // Either may come first (a script after `</body>`); at the same place the
  // installer goes first. Neither range overlaps the other.
  const edits = [
    { start: installerAt, end: installerAt, text: installerTag },
    { ...bundlePlace, text: bundleTag },
  ].sort((a, b) => a.start - b.start);
  let page = '';
  let cursor = 0;
  for (const edit of edits) {
    page += authored.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return page + authored.slice(cursor);
}

async function describeDataSchema(
  src: string,
  toolchain: SourceToolchain,
): Promise<unknown> {
  const schemaPath = path.join(src, 'data', 'schema.ts');
  if (!(await pathExists(schemaPath))) {
    throw manifestInvalid(
      ['capabilities', 'dataTable'],
      'is true but data/schema.ts does not exist',
    );
  }
  const descriptor = await toolchain.describe();
  try {
    return JSON.parse(descriptor) as unknown;
  } catch (error) {
    throw new Error(
      `Data Table schema is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * A disposable copy of `originalSrc` below the host's work directory, without
 * any checkout's own installations or generated roots and without links.
 * The caller removes it.
 */
async function copySource(
  host: BuildHost,
  id: string,
  originalSrc: string,
): Promise<string> {
  try {
    await fs.access(originalSrc);
  } catch (error) {
    // Only a missing source is the caller's problem; any other failure
    // (permissions, I/O) is the host's and stays an internal error.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The message reaches the caller, so it names the App, not a host path.
    throw new Error(`App source not found for ${id}.`);
  }

  // The copy's real path: bundler boundaries compare real paths, and a
  // scratch directory below a symlink (macOS /var -> /private/var) would
  // otherwise put every module "outside" the source root.
  await fs.mkdir(path.join(host.workDir, id), { recursive: true });
  const src = path.join(
    await fs.realpath(path.join(host.workDir, id)),
    randomUUID(),
  );
  try {
    await fs.cp(originalSrc, src, {
      recursive: true,
      // Reproduce dependencies from the committed lock below; never trust or
      // waste time copying a source checkout's pre-existing installations. The
      // exclusions are platform-generated roots; matching only the first path
      // segment keeps identically named authored directories below app/, widgets/,
      // backend/assets/, and other source trees intact.
      filter: (source) => {
        const relative = path
          .relative(originalSrc, source)
          .split(path.sep)
          .join('/');
        const rootEntry = relative.split('/', 1)[0]?.toLowerCase();
        return ![
          '.git',
          '.hatch',
          'gen',
          'node_modules',
          // pnpm writes this file itself; install never reads it.
          NODE_TOOLCHAIN_IGNORED_ROOT_FILE,
        ].includes(rootEntry);
      },
    });
    await assertSourceHasNoSymlinks(src);
  } catch (error) {
    await removeOwned(src);
    throw error;
  }
  return src;
}

/**
 * Evaluate the manifest of `sourceDir` and nothing else, as the platform does
 * to bind a build package to its commit: whoever built the package is not
 * trusted with what the manifest grants. Most manifests import only the SDK
 * and the App's own files, so they are evaluated without installing
 * dependencies; one that needs them (it imports a package) is evaluated
 * again after the committed lockfile is installed.
 */
export async function evaluateAppSourceManifest(
  host: BuildHost,
  options: {
    appId: string;
    sourceDir: string;
    /**
     * Runs the evaluation while the copy at `src` is the sandbox's (the
     * platform hands it to the sandbox identity, which installs into it).
     */
    withSource?: <T>(src: string, task: () => Promise<T>) => Promise<T>;
    /** Largest installed dependency tree the fallback accepts. */
    maxInstallBytes?: number;
  },
): Promise<{ manifest: SourceManifest; installed: boolean }> {
  const src = await copySource(host, options.appId, options.sourceDir);
  const logs: string[] = [];
  const withSource =
    options.withSource ?? (<T>(_src: string, task: () => Promise<T>) => task());
  try {
    if ((await detectSourceManifest(src)) === 'manifest.json') {
      const { manifest } = await loadSourceManifest(src, {
        parse: parseSourceManifest,
      });
      return { manifest, installed: false };
    }
    const toolchain = createSourceToolchain(
      await detectSourceToolchain(sourceToolchainReader(src)),
      host.toolchainContext(src, logs),
    );
    await host.materializeSdk(src);
    return await withSource(src, async () => {
      try {
        const { manifest } =
          await toolchain.evaluateManifest(parseSourceManifest);
        return { manifest, installed: false };
      } catch {
        // Whatever failed without packages is decided with them: the frozen
        // lockfile, installed without scripts, used for this evaluation only.
        await toolchain.validateDependencies();
        await toolchain.install();
        if (options.maxInstallBytes !== undefined) {
          const size = await treeSize(path.join(src, 'node_modules'));
          if (size > options.maxInstallBytes) {
            throw new Error(
              `The installed dependencies take ${size} bytes; the manifest ` +
                `may be evaluated with at most ${options.maxInstallBytes}.`,
            );
          }
        }
        const { manifest } =
          await toolchain.evaluateManifest(parseSourceManifest);
        return { manifest, installed: true };
      }
    });
  } finally {
    await removeOwned(src);
  }
}

/** Bytes of the regular files below `root` (links are not followed). */
async function treeSize(root: string): Promise<number> {
  let total = 0;
  const entries = await fs
    .readdir(root, { withFileTypes: true, recursive: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await fs.lstat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/** Build `sourceDir` into a build package at `outDir`. */
export async function buildAppSource(
  host: BuildHost,
  options: BuildAppSourceOptions,
): Promise<BuildPackageManifest> {
  const { appId: id, deploymentId } = options;
  const originalSrc = options.sourceDir;
  const out = options.outDir;
  const logs: string[] = [];

  const src = await copySource(host, id, originalSrc);
  // Never inside the block below, whose failure path removes `out`: a
  // directory that already exists is not this build's to remove.
  await fs.mkdir(out, { recursive: false }).catch(async (error) => {
    await removeOwned(src);
    throw error;
  });

  try {
    // The host may hand the copy to the sandbox identity for the whole
    // build: every tool then runs as that identity and can write only here.
    const withSource =
      host.withSource ?? (<T>(_src: string, task: () => Promise<T>) => task());
    return await withSource(src, async () => {
      const manifestFile = await detectSourceManifest(src);
      const legacy =
        manifestFile === 'manifest.json'
          ? await loadSourceManifest(src, {
              parse: parseSourceManifest,
            })
          : undefined;

      // The committed lockfile selects the build pipeline before any source is
      // evaluated; it is independent of the runtime the manifest declares.
      const toolchainName = await detectSourceToolchain(
        sourceToolchainReader(src),
      );
      const toolchain = createSourceToolchain(
        toolchainName,
        host.toolchainContext(src, logs),
      );
      await toolchain.validateDependencies();

      // Agent worktree dependencies are intentionally absent from deploy bundles.
      // After validating authored dependency metadata, materialize the trusted
      // SDK and fixed platform import map inside this disposable checkout.
      await host.materializeSdk(src);

      // Reproduce the dependency install from the committed lockfile. Neither
      // pipeline runs npm lifecycle scripts.
      await toolchain.install();

      const { manifest } =
        legacy ?? (await toolchain.evaluateManifest(parseSourceManifest));

      // The manifest id drives every generated URL (app/widget/RPC). The
      // platform checks it again; failing here saves the rest of the build.
      if (manifest.id !== id) {
        throw manifestInvalid(
          ['id'],
          `does not match the App id "${id}"`,
        ).inFile(manifestFile);
      }

      // Connect codegen from proto (if the app has a backend RPC service), and
      // the compiled descriptor set the platform reads the App's API from.
      const protoPath = manifest.rpc
        ? path.join(src, manifest.rpc.proto)
        : null;
      if (manifest.rpc && protoPath) {
        const protoEntry = await fs.lstat(protoPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (!protoEntry) {
          throw manifestInvalid(['rpc', 'proto'], 'file not found').inFile(
            manifestFile,
          );
        }
        if (!protoEntry.isFile()) {
          throw manifestInvalid(
            ['rpc', 'proto'],
            'must name a regular file',
          ).inFile(manifestFile);
        }
        // `buf generate` executes the plugins listed in buf.gen.yaml, and `local:`
        // plugins are arbitrary commands. The file ships with the app source, so
        // overwrite it (we build from a temp copy) with the platform's fixed
        // codegen config so only the sanctioned plugin ever runs.
        await fs.writeFile(
          path.join(src, 'buf.gen.yaml'),
          PLATFORM_APP_BUF_GEN_YAML,
        );
        const gen = await host.runBuf(['generate'], src);
        logs.push(`$ buf generate\n${gen.output.trim()}`);
        if (gen.code !== 0) {
          throw new Error(`Connect codegen failed:\n${gen.output}`);
        }
        // Written to a file (not stdout) so buf warnings on stderr never corrupt
        // the descriptor. The binary form keeps custom options (task input
        // hints) and source comments.
        const built = await host.runBuf(
          ['build', '-o', path.join(out, BUILD_PACKAGE_API_DESCRIPTOR)],
          src,
        );
        if (built.code !== 0) {
          throw new Error(
            `buf build (API descriptor) failed:\n${built.output}`,
          );
        }
        const protoFiles = await copyProtoFiles(src, out);
        logs.push(`captured app API: ${protoFiles} proto file(s)`);
      }

      // Type-check every enabled manifest entry and its transitive imports after
      // the frozen install, before schema evaluation, bundling, or artifact writes.
      await checkAppSource(src, manifest, toolchain);

      // Source checking validates imports and types, but schema.ts still needs to
      // execute to produce the declarative migration descriptor.
      const dataSchema = manifest.capabilities.dataTable
        ? await describeDataSchema(src, toolchain)
        : null;

      await copyDeclaredDocs(src, out, manifest.docs);

      // Browser bundles may resolve only modules materialized inside this build's
      // disposable App root. The install above put every declared npm dependency there;
      // falling back to the host's own modules would make builds non-hermetic.
      const browserSourceRoot = await fs.realpath(src);
      const esbuildResolve = {
        absWorkingDir: src,
        plugins: [hatchSdkPlugin(src), sourceBoundaryPlugin(browserSourceRoot)],
        // Prevent esbuild from walking above the temporary App root in search of
        // a host tsconfig. The toolchain's type checker is the source of
        // truth for types.
        tsconfigRaw: {
          compilerOptions: {
            jsx: 'react-jsx' as const,
            jsxImportSource: 'react',
          },
        },
        metafile: true as const,
      };
      // `deno check --no-remote` rejects remote imports for Deno sources. tsc
      // accepts any import an ambient declaration covers, and esbuild keeps URL
      // imports external, so Node sources are checked on the bundle itself.
      const assertSelfContained = (
        result: esbuild.BuildResult<{ metafile: true }>,
        subject: string,
      ) => {
        if (toolchain.name === 'node') {
          assertNoBundleImports(result.metafile, subject);
        }
      };

      const define = browserDefine(id, manifest.name, deploymentId);
      const nativeFrontend =
        manifest.capabilities.frontend && manifest.app?.runtime === 'native';
      const storageInstall =
        (manifest.capabilities.frontend && manifest.app && !nativeFrontend) ||
        (manifest.capabilities.widgets && manifest.widgets.length > 0)
          ? await storageInstallScript(id, esbuildResolve)
          : '';

      // A native frontend: NSH deploy checks, the linked web module and the
      // bundle native shells load. The platform writes the player page.
      if (nativeFrontend && manifest.app) {
        // The descriptor's services decide which RPC calls the source rules
        // accept; the platform reads the same descriptor.
        const api = manifest.rpc ? (await readAppApi(out)).api : undefined;
        await buildNativeFrontend({
          src,
          out,
          workDir: host.workDir,
          app: { id, name: manifest.name, entry: manifest.app.entry },
          api,
          nsh: host.nsh(),
          logs,
        });
      }

      // Bundle the frontend SPA -> app/app.js, inlined into app/index.html.
      if (manifest.capabilities.frontend && manifest.app && !nativeFrontend) {
        const entry = path.join(src, manifest.app.entry);
        if (!(await pathExists(entry))) {
          throw manifestInvalid(['app', 'entry'], 'file not found').inFile(
            manifestFile,
          );
        }
        await fs.mkdir(path.join(out, 'app'), { recursive: true });
        const appBundle = await esbuild.build({
          ...esbuildResolve,
          entryPoints: [entry],
          outfile: path.join(out, 'app', 'app.js'),
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          jsx: 'automatic',
          minify: true,
          sourcemap: false,
          define,
          logLevel: 'silent',
        });
        assertSelfContained(appBundle, 'App bundle');
        const htmlRel = manifest.app.html ?? 'app/index.html';
        const htmlSrc = path.join(src, htmlRel);
        if (!(await pathExists(htmlSrc))) {
          throw manifestInvalid(['app', 'html'], 'file not found').inFile(
            manifestFile,
          );
        }
        // Inline the bundle into index.html. The platform serves the app over an
        // extensionless HTML route; inlining avoids a separate .js asset request
        // and keeps the app a single document.
        const html = composeAppHtml(
          await fs.readFile(htmlSrc, 'utf8'),
          storageInstall,
          await fs.readFile(path.join(out, 'app', 'app.js'), 'utf8'),
          htmlRel,
        );
        await fs.writeFile(path.join(out, 'app', 'index.html'), html, 'utf8');
        logs.push('bundled app -> inlined into app/index.html');
      }

      // Bundle each widget -> standalone ESM module exporting mount().
      if (manifest.capabilities.widgets && manifest.widgets.length > 0) {
        await fs.mkdir(path.join(out, 'widgets'), { recursive: true });
        for (const [index, widget] of manifest.widgets.entries()) {
          const entry = path.join(src, widget.entry);
          if (!(await pathExists(entry))) {
            throw manifestInvalid(
              ['widgets', index, 'entry'],
              'file not found',
            ).inFile(manifestFile);
          }
          const widgetBundle = await esbuild.build({
            ...esbuildResolve,
            entryPoints: [entry],
            outfile: path.join(out, 'widgets', `${widget.id}.js`),
            // Runs before the widget's modules: each widget has its own frame.
            banner: { js: storageInstall },
            bundle: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            jsx: 'automatic',
            minify: true,
            sourcemap: false,
            define,
            logLevel: 'silent',
          });
          assertSelfContained(widgetBundle, `Widget ${widget.id} bundle`);
          logs.push(`bundled widget ${widget.id} -> widgets/${widget.id}.js`);
        }
      }

      // Bundle the backend, generated stubs, and npm dependencies into one
      // runtime entry. Source files and dependency manifests remain build inputs;
      // only files below the fixed backend/assets directory enter the package.
      if (manifest.capabilities.backend && manifest.backend) {
        await copyBackendAssets(src, out);
        await validateBackendBundleSourceTree(src);

        const bundledEntry = backendBundleEntry(manifest.backend.entry);
        const bundlePath = path.join(out, bundledEntry);
        await fs.mkdir(path.dirname(bundlePath), { recursive: true });
        await toolchain.bundle({
          entry: manifest.backend.entry,
          outfile: bundlePath,
          outputRoot: out,
        });
        logs.push(`bundled backend -> ${bundledEntry}`);
      }

      const packageManifest: BuildPackageManifest = {
        format: BUILD_PACKAGE_FORMAT,
        appId: id,
        deploymentId,
        commit: options.commit,
        toolchain: toolchainName,
        manifestFile,
        manifest,
        dataSchema,
        tooling: await host.tooling({ native: Boolean(nativeFrontend) }),
        log: logs.join('\n').slice(0, 1_000_000),
      };
      await fs.writeFile(
        path.join(out, BUILD_PACKAGE_MANIFEST),
        JSON.stringify(packageManifest, null, 2),
        'utf8',
      );
      return packageManifest;
    });
  } catch (error) {
    // A failed build leaves no partial package behind.
    await removeOwned(out);
    throw error;
  } finally {
    await removeOwned(src);
  }
}
