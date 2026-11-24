import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { useWindowDimensions, View } from 'react-native';
import { palette } from './theme';
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
};

// Decorative symbol in a square box; the surrounding control owns its
// accessible name.
export function Glyph({ name, size = 18, color = palette.ink }: GlyphProps) {
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
        tintColor={color}
      />
    </View>
  );
}
