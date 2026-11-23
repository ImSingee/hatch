import { View } from 'react-native';
import { useAccent } from './accent';
import { palette as c } from './theme';

/**
 * The Desk ground shapes (DESIGN.md, "Ground shapes"): three flat tints lying
 * behind a page, cut off by its edges. The circle follows the accent. Sizes,
 * positions and corner radii are geometry of the drawing, as on the web
 * shell's narrowest layout; the colours are tokens.
 *
 * Rendered as the last child of a page so native tabs still find the page's
 * scroll view first, and drawn under its siblings.
 */
export function Ground() {
  const accent = useAccent();
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: -1,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: -150,
          right: -170,
          width: 440,
          height: 440,
          borderRadius: '50%',
          backgroundColor: accent.ground,
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: -100,
          left: -140,
          width: 360,
          height: 320,
          borderRadius: 90,
          backgroundColor: c.groundWarm,
          transform: [{ rotate: '-12deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 520,
          right: -70,
          width: 190,
          height: 190,
          borderRadius: 48,
          backgroundColor: c.groundFresh,
          transform: [{ rotate: '18deg' }],
        }}
      />
    </View>
  );
}
