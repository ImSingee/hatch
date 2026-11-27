import { Host } from '@expo/ui';
import { Image } from '@expo/ui/swift-ui';
import { accessibilityHidden } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions, View } from 'react-native';
import { usePalette, useTheme } from './theme-context';
import { glyphs, type GlyphProps } from './glyph.types';

// Decorative SF Symbol in a square box, so symbols of different proportions
// share one optical line. The surrounding control owns its accessible name.
export function Glyph({ name, size = 18, color }: GlyphProps) {
  const c = usePalette();
  const { appearance } = useTheme();
  const tint = color ?? c.ink;
  const { fontScale } = useWindowDimensions();
  const scaled = Math.round(size * Math.min(Math.max(fontScale, 1), 1.6));
  const box = Math.round(scaled * 1.25);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        width: box,
        height: box,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Host colorScheme={appearance} matchContents ignoreSafeArea="all">
        <Image
          systemName={glyphs[name]}
          size={scaled}
          color={tint}
          modifiers={[accessibilityHidden(true)]}
        />
      </Host>
    </View>
  );
}
