export type FoldRect = { x: number; y: number; width: number; height: number };
export type FoldProbeProps = { onFolds: (folds: FoldRect[]) => void };
/** Where the system puts the vertical bar; `none` where it uses none. */
export type VerticalBarEdge = 'leading' | 'trailing' | 'none';
export type VerticalBarProbeProps = {
  onChange: (edge: VerticalBarEdge) => void;
};
