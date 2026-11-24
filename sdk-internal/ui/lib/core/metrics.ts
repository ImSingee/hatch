/**
 * Geometry from DESIGN.md that NSH takes as numbers rather than classes:
 * table rows and columns, measured in points. The only file of the library
 * with literal sizes besides the generated theme.
 */

/** DESIGN.md "List row": table header 34, body cells 38. */
export const TABLE_HEADER_HEIGHT = 34;
export const TABLE_ROW_HEIGHT = 38;
/** Body text of a table cell (DESIGN.md "Body"). */
export const TABLE_FONT_SIZE = 14;

/** Column widths a `DataTable` column can ask for. */
export const COLUMN_WIDTH = {
  xs: 72,
  sm: 112,
  md: 160,
  lg: 240,
  xl: 320,
} as const;
