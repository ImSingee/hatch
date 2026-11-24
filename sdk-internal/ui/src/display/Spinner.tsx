import { Canvas, View } from 'nsh';
import type { JSX } from 'nsh';
import { ICON_SIZE_CLASS, colorToken } from '../icons/Icon';
import type { GlyphColor, IconSize } from '../icons/Icon';

/** A three-quarter ring that turns while work runs. Internal: `Button`'s
 * loading state, `DataTable` and `List` loading rows. */
export function Spinner(props: {
  size: IconSize;
  color: GlyphColor;
}): JSX.Element {
  return (
    <View
      class={`${ICON_SIZE_CLASS[props.size]} animate-spin motion-reduce:animate-none`}
      importantForAccessibility="no-hide-descendants"
    >
      <Canvas
        class="size-full"
        draw={(cx, { width }) => {
          const stroke = width / 8;
          const radius = width / 2 - stroke;
          cx.lineWidth = stroke;
          cx.lineCap = 'round';
          cx.strokeStyle = colorToken(props.color);
          cx.beginPath();
          cx.arc(width / 2, width / 2, radius, 0, Math.PI * 1.5);
          cx.stroke();
        }}
      />
    </View>
  );
}
