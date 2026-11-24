/**
 * Every file the `@hatch/ui` generator owns, with its expected content.
 * `generate.ts` writes them; the sync test compares them with the files on
 * disk, so a token, icon or component change that was not regenerated fails.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCENT_NAMES, buildAppTheme } from '../theme/build.ts';
import { buildTailwindExtension } from '../theme/tailwind.ts';
import { renderTokenModule } from './tokens.ts';
import { buildCatalogueReference } from './catalogue.ts';
import { buildIcons, renderIconModule } from './icons.ts';

export const UI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const REPO_ROOT = path.resolve(UI_ROOT, '../..');

export type GeneratedFile = { path: string; content: string };

/** Formats `content` as Oxfmt formats the file at `filePath`. */
export function formatAs(filePath: string, content: string): string {
  const oxfmt = path.join(REPO_ROOT, 'node_modules/.bin/oxfmt');
  return execFileSync(oxfmt, [`--stdin-filepath=${filePath}`], {
    cwd: REPO_ROOT,
    input: content,
    encoding: 'utf8',
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generatedFiles(): GeneratedFile[] {
  const icons = buildIcons();
  const files: GeneratedFile[] = [
    { path: 'lib/theme.json', content: json(buildAppTheme()) },
    { path: 'lib/tailwind.json', content: json(buildTailwindExtension()) },
    { path: 'lib/icons/icons.gen.ts', content: renderIconModule(icons) },
    { path: 'lib/core/tokens.gen.ts', content: renderTokenModule() },
    {
      path: 'gallery/web/themes.json',
      content: json(
        Object.fromEntries(
          ACCENT_NAMES.map((accent) => [accent, buildAppTheme({ accent })]),
        ),
      ),
    },
    {
      path: '../../skills/building-apps/references/design-system.md',
      content: buildCatalogueReference(icons),
    },
  ];
  return files.map((file) => {
    const absolute = path.resolve(UI_ROOT, file.path);
    return { path: absolute, content: formatAs(absolute, file.content) };
  });
}
