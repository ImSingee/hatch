/**
 * The icon set of `@hatch/ui`: a closed list of Tabler outline icons, turned
 * into path data in a JS module (`src/icons/icons.gen.ts`). A bundle keeps
 * only the icons it imports, because each is a plain constant; SVG imports
 * would ship every icon a reachable module names.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

/** Tabler names, grouped for the catalogue. Add here, then regenerate. */
export const ICON_GROUPS: Record<string, readonly string[]> = {
  Actions: [
    'plus',
    'minus',
    'x',
    'check',
    'pencil',
    'trash',
    'copy',
    'clipboard',
    'share',
    'download',
    'upload',
    'send',
    'refresh',
    'rotate',
    'search',
    'filter',
    'adjustments-horizontal',
    'sort-ascending',
    'sort-descending',
    'dots',
    'dots-vertical',
    'external-link',
    'link',
    'paperclip',
    'printer',
    'zoom-in',
    'zoom-out',
    'maximize',
    'minimize',
    'logout',
    'login',
    'grip-vertical',
  ],
  Navigation: [
    'chevron-left',
    'chevron-right',
    'chevron-up',
    'chevron-down',
    'selector',
    'arrow-left',
    'arrow-right',
    'arrow-up',
    'arrow-down',
    'arrow-up-right',
    'menu-2',
    'home',
    'home-2',
    'layout-sidebar',
    'layout-grid',
    'list',
    'table',
    'dashboard',
    'typography',
    'settings',
  ],
  Status: [
    'circle-check',
    'circle-x',
    'alert-triangle',
    'alert-circle',
    'info-circle',
    'help-circle',
    'circle-plus',
    'square-check',
    'eye',
    'eye-off',
    'lock',
    'lock-open',
    'key',
    'shield',
    'bell',
    'flag',
    'pin',
    'star',
    'heart',
    'bookmark',
    'bolt',
    'sparkles',
    'circle',
    'loader-2',
    'activity',
    'bug',
  ],
  Objects: [
    'user',
    'users',
    'user-plus',
    'calendar',
    'calendar-event',
    'clock',
    'alarm',
    'hourglass',
    'history',
    'mail',
    'inbox',
    'archive',
    'message',
    'messages',
    'phone',
    'at',
    'hash',
    'tag',
    'folder',
    'file',
    'file-text',
    'notebook',
    'notes',
    'book',
    'news',
    'rss',
    'checklist',
    'list-check',
    'photo',
    'camera',
    'music',
    'video',
    'microphone',
    'volume',
    'player-play',
    'player-pause',
    'player-stop',
    'repeat',
    'map',
    'map-pin',
    'world',
    'wifi',
    'device-mobile',
    'device-desktop',
    'apps',
    'rocket',
    'git-pull-request',
    'code',
    'terminal',
    'database',
    'server',
    'robot',
    'wand',
    'bulb',
    'palette',
    'brush',
    'tool',
    'hammer',
    'box',
    'package',
    'stack-2',
    'layers-subtract',
    'qrcode',
    'speakerphone',
    'ticket',
    'target',
    'award',
    'trophy',
    'confetti',
    'gift',
  ],
  'Money and shopping': [
    'currency-dollar',
    'coin',
    'cash',
    'wallet',
    'credit-card',
    'receipt',
    'percentage',
    'shopping-cart',
    'basket',
    'building-store',
    'truck',
    'scale',
  ],
  Charts: [
    'chart-bar',
    'chart-line',
    'chart-pie',
    'trending-up',
    'trending-down',
  ],
  'Life and nature': [
    'sun',
    'moon',
    'cloud',
    'cloud-rain',
    'snowflake',
    'temperature',
    'umbrella',
    'droplet',
    'flame',
    'plant',
    'leaf',
    'tree',
    'mountain',
    'beach',
    'coffee',
    'glass',
    'salad',
    'bread',
    'cake',
    'run',
    'barbell',
    'bed',
    'heartbeat',
    'pill',
    'paw',
    'dog',
    'cat',
    'car',
    'plane',
    'briefcase',
    'school',
    'mood-smile',
  ],
};

type TablerNode = [tag: string, attributes: Record<string, string>];

function loadTablerNodes(): Record<string, TablerNode[]> {
  // `@tabler/icons` comes with `@tabler/icons-react`, the platform's icons.
  const require = createRequire(import.meta.url);
  const reactPackage = require.resolve('@tabler/icons-react/package.json');
  const fromReact = createRequire(path.join(path.dirname(reactPackage), '_'));
  return fromReact('@tabler/icons/tabler-nodes-outline.json') as Record<
    string,
    TablerNode[]
  >;
}

/** `chevron-left` -> `IconChevronLeft`; `menu-2` -> `IconMenu2`. */
export function iconExportName(name: string): string {
  return `Icon${name
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')}`;
}

export type GeneratedIcon = { name: string; exportName: string; d: string };

export function buildIcons(): GeneratedIcon[] {
  const nodes = loadTablerNodes();
  return Object.values(ICON_GROUPS)
    .flat()
    .map((name) => {
      const parts = nodes[name];
      if (!parts) throw new Error(`Tabler has no outline icon "${name}"`);
      const d = parts
        .map(([tag, attributes]) => {
          if (tag !== 'path' || !attributes.d) {
            throw new Error(`Icon "${name}" has a <${tag}>; only paths load`);
          }
          return attributes.d;
        })
        .join(' ');
      return { name, exportName: iconExportName(name), d };
    });
}

export function renderIconModule(icons: readonly GeneratedIcon[]): string {
  const lines = [
    '// Generated by sdk-internal/ui/scripts/generate.ts from Tabler outline',
    '// icons (MIT). Do not edit; add names in scripts/icons.ts instead.',
    "import type { IconData } from './icon-data';",
    '',
  ];
  for (const icon of icons) {
    lines.push(
      `export const ${icon.exportName}: IconData = { name: '${icon.name}', d: '${icon.d}' };`,
    );
  }
  return `${lines.join('\n')}\n`;
}
