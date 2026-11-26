import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { useWindowDimensions, View } from 'react-native';
import { usePalette } from './theme-context';
import type { GlyphName, GlyphProps } from './glyph.types';

// Android draws each glyph with the Material symbol that plays the SF
// Symbol's part on iOS.
const symbols: Record<GlyphName, AndroidSymbol> = {
  home: 'home',
  dashboard: 'dashboard',
  apps: 'apps',
  agent: 'auto_awesome',
  person: 'person',
  more: 'more_horiz',
  open: 'north_east',
  refresh: 'refresh',
  plus: 'add',
  chevron: 'chevron_right',
  search: 'search',
  clear: 'cancel',
  close: 'close',
  send: 'arrow_upward',
  attach: 'attach_file',
  stop: 'stop',
  pin: 'push_pin',
  hash: 'tag',
  sliders: 'tune',
  server: 'dns',
  up: 'arrow_upward',
  down: 'arrow_downward',
  browser: 'open_in_browser',
  warning: 'warning',
  alert: 'error',
  check: 'check',
  file: 'description',
  photo: 'image',
  signOut: 'logout',
  model: 'memory',
  question: 'help',
  eyeSlash: 'visibility_off',
  sparkle: 'auto_awesome',
  bell: 'notifications',
  settings: 'settings',
  trash: 'delete',
  edit: 'edit',
  pause: 'pause',
  info: 'info',
  pinSlash: 'keep_off',
  chevronDown: 'expand_more',
  circle: 'radio_button_unchecked',
  minus: 'remove',
  square: 'check_box_outline_blank',
  checkSquare: 'check_box',
  pullRequest: 'merge',
  deploy: 'rocket_launch',
  task: 'checklist',
  shield: 'verified_user',
  chart: 'bar_chart',
  clock: 'schedule',
  database: 'database',
  bug: 'bug_report',
  message: 'chat_bubble',
  package: 'inventory_2',
  money: 'payments',
};

// Decorative symbol in a square box; the surrounding control owns its
// accessible name.
export function Glyph({ name, size = 18, color }: GlyphProps) {
  const c = usePalette();
  const tint = color ?? c.ink;
  const { fontScale } = useWindowDimensions();
  const scaled = Math.round(size * Math.min(Math.max(fontScale, 1), 1.6));
  const box = Math.round(scaled * 1.25);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        width: box,
        height: box,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SymbolView
        name={{ android: symbols[name] }}
        size={box}
        tintColor={tint}
      />
    </View>
  );
}
