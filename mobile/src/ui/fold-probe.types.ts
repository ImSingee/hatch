export type FoldRect = { x: number; y: number; width: number; height: number };
import type { Hinge } from './fold-split';

export type FoldProbeProps = {
  onFolds: (folds: FoldRect[]) => void;
  /** The state of the hinge the display folds on. */
  onHinge?: (hinge: Hinge) => void;
};
/** Where the system puts the vertical bar; `none` where it uses none. */
export type VerticalBarEdge = 'leading' | 'trailing' | 'none';
export type VerticalBarProbeProps = {
  onChange: (edge: VerticalBarEdge) => void;
};
