import type { ReactElement } from 'react';
import type { GlyphName } from './glyph.types';

export type TileMenuAction = {
  label: string;
  glyph: GlyphName;
  onPress: () => void;
  /** Removes something, such as a pin; shown in red. */
  destructive?: boolean;
};

export type TileMenuProps = {
  actions: TileMenuAction[];
  /**
   * Renders the tile. Where the platform does not open the menu by itself
   * (Android), `onLongPress` opens it and the tile must call it; on iOS the
   * system menu takes the touch and hold, and it is undefined.
   */
  children: (onLongPress: (() => void) | undefined) => ReactElement;
};
