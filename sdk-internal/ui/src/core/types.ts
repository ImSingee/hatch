/**
 * The typed vocabulary components vary by. Every value maps to tokens inside
 * the component; none is a colour, a length or a class.
 */
import type { IconData } from '../icons/icon-data';

/** A step of the spacing scale: 0, 4, 8, 12, 16, 24 and 32 points. */
export type Space = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** Cross-axis alignment of a stack's children. */
export type Align = 'start' | 'center' | 'end' | 'stretch';

/** Main-axis distribution of a stack's children. */
export type Justify = 'start' | 'center' | 'end' | 'between';

/** What a colour means. Colour never carries meaning alone: pair a tone with
 * a word or an icon. */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

/** A control's size. */
export type ControlSize = 'sm' | 'md' | 'lg';

/** An action shown as a button: in an empty state, a menu, a row. */
export type Action = {
  label: string;
  onPress: () => void;
  icon?: IconData;
  disabled?: boolean;
};

export type { IconData };
