import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { FOCUS_RING, GAP } from '../core/styles';
import { HeadingText } from '../display/Text';
import type { Space } from '../core/types';

/** Title, description and actions above a card's or section's content. */
function Header(props: {
  title?: string;
  description?: string;
  actions?: JSX.Element;
}): JSX.Element {
  return (
    <View class="flex-row items-start gap-3">
      <View class="flex-1 gap-0.5">
        {props.title ? (
          <HeadingText level={3} class="text-subsection text-foreground">
            {props.title}
          </HeadingText>
        ) : null}
        {props.description ? (
          <Text class="text-body text-muted-foreground text-pretty">
            {props.description}
          </Text>
        ) : null}
      </View>
      {props.actions ? (
        <View class="flex-row items-center gap-2">{props.actions}</View>
      ) : null}
    </View>
  );
}

export type CardProps = {
  children?: JSX.Element;
  title?: string;
  description?: string;
  /** Buttons at the end of the title row. */
  actions?: JSX.Element;
  /** Inner padding: `none`, `sm` 12, `md` 16 (default) or `lg` 24 points. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Space between the header and the content's children; default `md`. */
  gap?: Space;
  /** Makes the whole card one button. Give it a `title`: screen readers
   * read the title as the button's name. Do not put other buttons inside. */
  onPress?: () => void;
};

const PADDING: Record<NonNullable<CardProps['padding']>, string> = {
  none: 'p-0',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

const SURFACE =
  'self-stretch rounded-(--radius-lg) border border-hairline bg-card overflow-hidden';

/**
 * A white sheet that groups related content. Inside an App, cards sit flat
 * on the window body with a hairline, as grouped content does in Desk
 * windows.
 */
export function Card(props: CardProps): JSX.Element {
  const body = () => (
    <>
      {props.title || props.description || props.actions ? (
        <Header
          title={props.title}
          description={props.description}
          actions={props.actions}
        />
      ) : null}
      {props.children}
    </>
  );
  const layout = () =>
    `${SURFACE} ${PADDING[props.padding ?? 'md']} flex-col ${GAP[props.gap ?? 'md']}`;
  if (props.onPress) {
    return (
      <BaseButton
        onPress={props.onPress}
        accessibilityLabel={props.title}
        class={`${layout()} items-stretch transition hover:shadow-dock hover:-translate-y-px active:translate-y-0 ${FOCUS_RING}`}
      >
        {body()}
      </BaseButton>
    );
  }
  return <View class={layout()}>{body()}</View>;
}

export type SectionProps = {
  children?: JSX.Element;
  title?: string;
  description?: string;
  /** Buttons at the end of the title row. */
  actions?: JSX.Element;
  /** Space between the header and the children; default `md`. */
  gap?: Space;
};

/** A titled group of content on a page. */
export function Section(props: SectionProps): JSX.Element {
  return (
    <View class={`self-stretch flex-col ${GAP[props.gap ?? 'md']}`}>
      {props.title || props.description || props.actions ? (
        <Header
          title={props.title}
          description={props.description}
          actions={props.actions}
        />
      ) : null}
      {props.children}
    </View>
  );
}

export type DividerProps = {
  /** A vertical line between items of a row. */
  vertical?: boolean;
};

/** A hairline between groups of content. */
export function Divider(props: DividerProps): JSX.Element {
  return (
    <View
      role="none"
      class={
        props.vertical
          ? 'w-px self-stretch bg-hairline'
          : 'h-px self-stretch bg-hairline'
      }
    />
  );
}
