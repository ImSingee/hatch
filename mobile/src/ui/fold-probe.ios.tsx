import { requireNativeView } from 'expo';
import { StyleSheet } from 'react-native';
import type { Hinge } from './fold-split';
import type {
  FoldProbeProps,
  FoldRect,
  VerticalBarEdge,
  VerticalBarProbeProps,
} from './fold-probe.types';

const HatchFold = requireNativeView<{
  style: unknown;
  pointerEvents: 'none';
  onFoldChange?: (event: { nativeEvent: { folds: FoldRect[] } }) => void;
  onHingeChange?: (event: { nativeEvent: { hinge: Hinge } }) => void;
  onVerticalBarChange?: (event: {
    nativeEvent: { edge: VerticalBarEdge };
  }) => void;
}>('HatchFold');

/**
 * Fills its container, behind the content, and reports where the display
 * folds across it in the container's coordinates, and how far the hinge is
 * open (`modules/hatch-fold`).
 */
export function FoldProbe({ onFolds, onHinge }: FoldProbeProps) {
  return (
    <HatchFold
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onFoldChange={(event) => onFolds(event.nativeEvent.folds)}
      onHingeChange={
        onHinge ? (event) => onHinge(event.nativeEvent.hinge) : undefined
      }
    />
  );
}

/**
 * Reports the edge where the system puts the vertical bar for the screen it
 * is mounted in (an iPhone Duo, folded or open), or `none`. The navigation
 * bar's items move to that bar. Builds without the iOS 27.1 SDK report
 * `none`.
 */
export function VerticalBarProbe({ onChange }: VerticalBarProbeProps) {
  return (
    <HatchFold
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onVerticalBarChange={(event) => onChange(event.nativeEvent.edge)}
    />
  );
}
