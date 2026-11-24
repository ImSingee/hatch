import type { FoldProbeProps, VerticalBarProbeProps } from './fold-probe.types';

/** Only iOS reports folds; elsewhere a container has none. */
export function FoldProbe(_props: FoldProbeProps) {
  return null;
}

/** Only iOS has a vertical bar. */
export function VerticalBarProbe(_props: VerticalBarProbeProps) {
  return null;
}
