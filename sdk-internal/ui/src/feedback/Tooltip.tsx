import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Tooltip as BaseTooltip } from 'nsh/base';
import { touch } from '../core/env';

/** A tooltip's bubble (DESIGN.md "Tooltip"): ink fill, white text. */
export function TooltipBubble(props: { label: string }): JSX.Element {
  return (
    <BaseTooltip
      placement="top"
      offset={6}
      class="max-w-64 rounded-(--radius-sm) bg-foreground px-2 py-1 transition-opacity duration-100"
      startingClass="opacity-0"
      endingClass="opacity-0"
    >
      <Text class="text-caption font-strong text-background">
        {props.label}
      </Text>
    </BaseTooltip>
  );
}

export type TooltipProps = {
  /** A short hint, one line: what the element does or what it shows. */
  label: string;
  /** The element the hint is about. */
  children?: JSX.Element;
};

/**
 * A hint shown while the pointer rests on its element, on desktops. Touch
 * screens have no hover, so never put information only in a tooltip.
 */
export function Tooltip(props: TooltipProps): JSX.Element {
  if (touch) return <>{props.children}</>;
  return (
    <View class="self-start" tooltip={<TooltipBubble label={props.label} />}>
      {props.children}
    </View>
  );
}
