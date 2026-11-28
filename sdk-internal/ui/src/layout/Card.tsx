import { Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { byLook } from '../core/env';
import { FOCUS_RING, GAP } from '../core/styles';
import { SurfaceContext } from '../core/surface';
import { BODY, HeadingText, TITLE } from '../display/Text';
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
          <HeadingText level={2} class={`${TITLE.card} text-foreground`}>
            {props.title}
          </HeadingText>
        ) : null}
        {props.description ? (
          <Text class={`${BODY.body} text-muted-foreground text-pretty`}>
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

/** On iOS and Android a card sits on the page's ground without an edge;
 * on Windows it takes Fluent's smaller card corner. */
const SURFACE = byLook({
  web: 'self-stretch rounded-(--radius-lg) border border-hairline bg-card overflow-hidden',
  ios: 'self-stretch rounded-(--radius-lg) bg-card overflow-hidden',
  android: 'self-stretch rounded-(--radius-lg) bg-card overflow-hidden',
  macos:
    'self-stretch rounded-(--radius-lg) border border-hairline bg-card overflow-hidden',
  windows:
    'self-stretch rounded-(--radius-sm) border border-hairline bg-card overflow-hidden',
});

/** How a pressable card answers a press. */
const PRESS = byLook({
  web: 'transition hover:shadow-dock hover:-translate-y-px active:translate-y-0',
  ios: 'transition-opacity active:opacity-60',
  android: 'transition-colors active:bg-muted',
  macos: 'transition-colors active:bg-muted',
  windows: 'transition-colors hover:bg-muted active:bg-surface-hover',
});

/**
 * A white sheet that groups related content. Inside an App, cards sit flat
 * on the window body with a hairline, as grouped content does in Desk
 * windows.
 */
export function Card(props: CardProps): JSX.Element {
  // The header's actions sit on the card too.
  const body = () => (
    <SurfaceContext.Provider value="card">
      {props.title || props.description || props.actions ? (
        <Header
          title={props.title}
          description={props.description}
          actions={props.actions}
        />
      ) : null}
      {props.children}
    </SurfaceContext.Provider>
  );
  const layout = () =>
    `${SURFACE} ${PADDING[props.padding ?? 'md']} flex-col ${GAP[props.gap ?? 'md']}`;
  if (props.onPress) {
    return (
      <BaseButton
        onPress={props.onPress}
        accessibilityLabel={props.title}
        class={`${layout()} items-stretch ${PRESS} ${FOCUS_RING}`}
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
