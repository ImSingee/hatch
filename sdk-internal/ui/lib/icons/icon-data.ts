/**
 * An icon: SVG path data on a 24-point grid, drawn as a 2-point stroke with
 * round caps and joins (Tabler's outline style).
 */
export type IconData = {
  /** The Tabler name, for tests and the catalogue. */
  readonly name: string;
  /** The SVG path data. */
  readonly d: string;
};
