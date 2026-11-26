/**
 * One renderer for the render tree that Markdown and card notifications
 * compile into, drawn with plain React Native views and nested text. The
 * platform draws a card's status, flag and the "who answered" line in fixed
 * places; everything else comes from the tree. Types this build does not
 * know fall back as `notification-content-model.ts` decides.
 */
import {
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
} from '@hatch/platform-api';
import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  Text as NativeText,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import {
  CARD_ROOT,
  answeredCardHead,
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  type ContentChild,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import type { NotificationAnswer } from '../core';
import { useOpenNotificationUrl } from '../state/use-open-notification-url';
import { useAccent } from './accent';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import {
  cardIconGlyph,
  codeLines,
  contentTime,
  fieldFromTree,
  flowGroups,
  gridColumns,
  holdsButtons,
  inlineForm,
  resolveChildren,
  stackButtons,
  trendBars,
  type BlockType,
  type FlowGroup,
} from './notification-content-model';
import { Tag, type TagTone } from './primitives';
import {
  ButtonStack,
  FormError,
  ReplyFieldInput,
  SubmitButton,
  answerButtons,
  useReplyForm,
  type ReplyFormState,
  type StackedButton,
} from './reply-card';
import { Text, type } from './text';
import { palette as c, fonts, pill, radii, status, weights } from './theme';

// ------------------------------------------------------------------ tokens

type Ramp = (typeof status)[keyof typeof status];

function rampOf(tone: unknown): Ramp | null {
  switch (tone) {
    case 'info':
    case 'success':
    case 'warning':
    case 'danger':
    case 'working':
      return status[tone];
    default:
      return null;
  }
}

/** Text ink for a tone; dimmed is the secondary ink. */
function toneInk(tone: unknown, fallback: string = c.ink): string {
  if (tone === 'dimmed') return c.inkSoft;
  return rampOf(tone)?.ink ?? fallback;
}

function tagTone(tone: unknown): TagTone {
  return rampOf(tone) ? (tone as TagTone) : 'quiet';
}

const SPACE: Record<string, number> = { xs: 4, sm: 6, md: 10, lg: 14, xl: 20 };
const SPACER: Record<string, number> = { xs: 4, sm: 8, md: 12, lg: 20, xl: 28 };
const PADDING: Record<string, number> = { sm: 8, md: 12, lg: 16 };

const TEXT_SIZE: Record<string, TextStyle> = {
  xs: { fontSize: 12, lineHeight: 16 },
  sm: { fontSize: 13, lineHeight: 18 },
  md: { fontSize: 15, lineHeight: 21 },
  lg: { fontSize: 17, lineHeight: 24 },
  xl: { fontSize: 24, lineHeight: 30 },
};
const TITLE_SIZE: Record<string, TextStyle> = {
  sm: { fontSize: 15, lineHeight: 20 },
  md: { fontSize: 17, lineHeight: 22 },
  lg: { fontSize: 20, lineHeight: 26 },
  xl: { fontSize: 24, lineHeight: 30 },
};
const TEXT_WEIGHT: Record<string, TextStyle['fontWeight']> = {
  regular: weights.body,
  medium: weights.strong,
  bold: weights.heading,
};

const ALIGN_TEXT: Record<string, TextStyle['textAlign']> = {
  start: 'left',
  center: 'center',
  end: 'right',
};
const ALIGN_ITEMS: Record<string, ViewStyle['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  baseline: 'baseline',
  stretch: 'stretch',
};
const JUSTIFY: Record<string, ViewStyle['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
};

/** Loose text in flow content (list items, quotes, Markdown paragraphs). */
const paragraph: TextStyle = { fontSize: 15, lineHeight: 21, color: c.ink };

// ------------------------------------------------------------ environment

type ContentEnv = {
  /** The live form, while the card's questions can be answered here. */
  form: ReplyFormState | null;
  reply: ReplyForm | null;
  /** The answer shown read-only, once given. */
  chosen: ReplyAnswers | null;
  selectable: boolean;
  open: (url: string) => void;
};

const Env = createContext<ContentEnv>({
  form: null,
  reply: null,
  chosen: null,
  selectable: false,
  open: () => {},
});

/** The reply field an inline input stands for, and whether it is live. */
function useBoundField(node: ContentNode): {
  field: ReplyField | null;
  form: ReplyFormState | null;
} {
  const env = useContext(Env);
  const id = propString(node, 'id');
  const bound = id
    ? env.reply?.fields.find((field) => field.id === id)
    : undefined;
  if (bound) return { field: bound, form: env.form };
  return { field: fieldFromTree(node), form: null };
}

// ----------------------------------------------------------------- inline

function Inline({ nodes }: { nodes: readonly ContentChild[] }): ReactNode {
  const accent = useAccent();
  const env = useContext(Env);
  const render = (
    children: readonly ContentChild[],
    key: string,
  ): ReactNode[] =>
    resolveChildren(children).map((child, index) => {
      const at = `${key}.${index}`;
      if (typeof child === 'string') return child;
      const inner = () => render(nodeChildren(child), at);
      switch (child.type) {
        case 'b':
          return (
            <NativeText key={at} style={{ fontWeight: weights.heading }}>
              {inner()}
            </NativeText>
          );
        case 'i':
          return (
            <NativeText key={at} style={{ fontStyle: 'italic' }}>
              {inner()}
            </NativeText>
          );
        case 's':
          return (
            <NativeText key={at} style={{ textDecorationLine: 'line-through' }}>
              {inner()}
            </NativeText>
          );
        case 'code':
          return (
            <NativeText
              key={at}
              style={{ fontFamily: fonts.mono, backgroundColor: c.muted }}
            >
              {inlineText(nodeChildren(child))}
            </NativeText>
          );
        case 'a': {
          const href = propString(child, 'href');
          return (
            <NativeText
              key={at}
              accessibilityRole="link"
              suppressHighlighting={false}
              onPress={href ? () => env.open(href) : undefined}
              style={{
                color: accent.ink,
                fontWeight: weights.label,
                textDecorationLine: 'underline',
              }}
            >
              {inner()}
            </NativeText>
          );
        }
        case 'time': {
          const datetime = propString(child, 'datetime');
          const format = propString(child, 'format');
          return datetime ? (
            <NativeText key={at}>
              {contentTime(
                datetime,
                format === 'date' || format === 'time' ? format : 'datetime',
              )}
            </NativeText>
          ) : null;
        }
        case 'br':
          return '\n';
        case 'Badge': {
          const ramp = rampOf(child.props?.tone);
          return (
            <NativeText
              key={at}
              style={{
                color: ramp?.ink ?? c.inkSoft,
                backgroundColor: ramp?.tint ?? c.hover,
                fontWeight: weights.label,
              }}
            >
              {` ${inlineText(nodeChildren(child))} `}
            </NativeText>
          );
        }
        case 'Icon': {
          const glyph = cardIconGlyph(propString(child, 'name'));
          return glyph ? (
            <Glyph
              key={at}
              name={glyph}
              size={13}
              color={toneInk(child.props?.tone, c.inkSoft)}
            />
          ) : null;
        }
        default:
          // A block in inline content (malformed): its text reads on.
          return inner();
      }
    });
  return <>{render(nodes, 'i')}</>;
}

function Paragraph({
  nodes,
  style,
  lines,
  header,
}: {
  nodes: readonly ContentChild[];
  style?: TextStyle | (TextStyle | false | undefined | null)[];
  lines?: number;
  header?: boolean;
}) {
  const { selectable } = useContext(Env);
  return (
    <Text
      accessibilityRole={header ? 'header' : undefined}
      selectable={selectable}
      numberOfLines={lines}
      style={style ?? paragraph}
    >
      <Inline nodes={nodes} />
    </Text>
  );
}

// ----------------------------------------------------------------- blocks

/** Flow content: paragraphs and blocks, `gap` apart. */
function Blocks({
  nodes,
  gap = 12,
  textStyle,
}: {
  nodes: readonly ContentChild[];
  gap?: number;
  textStyle?: TextStyle;
}) {
  const groups = flowGroups(nodes);
  if (groups.length === 0) return null;
  return (
    <View style={{ gap, alignSelf: 'stretch' }}>
      {groups.map((group, index) => (
        <Group key={index} group={group} textStyle={textStyle} />
      ))}
    </View>
  );
}

function Group({
  group,
  textStyle,
}: {
  group: FlowGroup;
  textStyle?: TextStyle;
}) {
  if (group.kind === 'inline') {
    return <Paragraph nodes={group.children} style={textStyle} />;
  }
  if (group.kind === 'markers') {
    return (
      <View style={styles.markers}>
        {group.children.map((node, index) => (
          <Block key={index} node={node} />
        ))}
      </View>
    );
  }
  return <Block node={group.node} />;
}

function Block({ node }: { node: ContentNode }) {
  const Render = (BLOCKS as Record<string, BlockRenderer | undefined>)[
    node.type
  ];
  if (Render) return <Render node={node} />;
  // A part outside its parent, or a mark among blocks (malformed): draw
  // what it holds.
  return <Blocks nodes={nodeChildren(node)} />;
}

type BlockRenderer = (props: { node: ContentNode }) => ReactNode;

function Root({ node }: { node: ContentNode }) {
  return <Blocks nodes={nodeChildren(node)} />;
}

function Column({ node }: { node: ContentNode }) {
  const gap = SPACE[propString(node, 'gap') ?? 'sm'];
  if (holdsButtons(node)) return <ButtonRow node={node} />;
  const groups = flowGroups(nodeChildren(node));
  return (
    <View
      style={{
        gap,
        alignItems: ALIGN_ITEMS[propString(node, 'align') ?? 'stretch'],
      }}
    >
      {groups.map((group, index) => (
        <Group key={index} group={group} />
      ))}
    </View>
  );
}

function Row({ node }: { node: ContentNode }) {
  if (holdsButtons(node)) return <ButtonRow node={node} />;
  const groups = flowGroups(nodeChildren(node));
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: propBool(node, 'wrap') ? 'wrap' : 'nowrap',
        gap: SPACE[propString(node, 'gap') ?? 'md'],
        justifyContent: JUSTIFY[propString(node, 'justify') ?? 'start'],
        alignItems: ALIGN_ITEMS[propString(node, 'align') ?? 'start'],
      }}
    >
      {groups.map((group, index) => (
        <View key={index} style={{ flexShrink: 1, minWidth: 0 }}>
          <Group group={group} />
        </View>
      ))}
    </View>
  );
}

function Grid({ node }: { node: ContentNode }) {
  const [width, setWidth] = useState(0);
  const gap = SPACE[propString(node, 'gap') ?? 'sm'];
  // Sized from its container, never the screen: fewer columns when narrow.
  const columns = gridColumns(width, propNumber(node, 'columns') ?? 2, gap);
  const groups = flowGroups(nodeChildren(node));
  const rows: FlowGroup[][] = [];
  for (let index = 0; index < groups.length; index += columns) {
    rows.push(groups.slice(index, index + columns));
  }
  return (
    <View
      style={{ gap }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={{ flexDirection: 'row', gap }}>
          {Array.from({ length: columns }, (_, index) => (
            <View key={index} style={{ flex: 1, minWidth: 0 }}>
              {row[index] ? <Group group={row[index]} /> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function Box({ node }: { node: ContentNode }) {
  const ramp = rampOf(node.props?.tone);
  const outline = propString(node, 'surface') === 'outline';
  return (
    <View
      style={{
        padding: PADDING[propString(node, 'padding') ?? 'md'],
        borderRadius: radii.md,
        ...(outline
          ? { borderWidth: 1, borderColor: ramp?.tintStrong ?? c.hairline }
          : { backgroundColor: ramp?.tint ?? c.muted }),
      }}
    >
      <Blocks nodes={nodeChildren(node)} gap={10} />
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

function Spacer({ node }: { node: ContentNode }) {
  return <View style={{ height: SPACER[propString(node, 'size') ?? 'md'] }} />;
}

function Collapse({ node }: { node: ContentNode }) {
  const accent = useAccent();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          styles.collapse,
          pressed && { backgroundColor: c.hover },
        ]}
      >
        <Glyph
          name={open ? 'chevronDown' : 'chevron'}
          size={11}
          color={accent.ink}
        />
        <Text
          style={[
            type.small,
            { flexShrink: 1, color: accent.ink, fontWeight: weights.label },
          ]}
        >
          {propString(node, 'summary') ?? 'Show more'}
        </Text>
      </Pressable>
      {open ? <Blocks nodes={nodeChildren(node)} /> : null}
    </View>
  );
}

function Title({ node }: { node: ContentNode }) {
  return (
    <Paragraph
      header
      nodes={nodeChildren(node)}
      lines={propNumber(node, 'lines')}
      style={[
        TITLE_SIZE[propString(node, 'size') ?? 'md'],
        {
          fontWeight: weights.heading,
          color: c.ink,
          textAlign: ALIGN_TEXT[propString(node, 'align') ?? 'start'],
        },
      ]}
    />
  );
}

function TextBlock({ node }: { node: ContentNode }) {
  const mono = propBool(node, 'mono');
  return (
    <Paragraph
      nodes={nodeChildren(node)}
      lines={propNumber(node, 'lines')}
      style={[
        TEXT_SIZE[propString(node, 'size') ?? 'md'],
        {
          color: toneInk(node.props?.tone),
          fontWeight: TEXT_WEIGHT[propString(node, 'weight') ?? 'regular'],
          textAlign: ALIGN_TEXT[propString(node, 'align') ?? 'start'],
        },
        mono && { fontFamily: fonts.mono },
      ]}
    />
  );
}

function Caption({ node }: { node: ContentNode }) {
  return (
    <Paragraph
      nodes={nodeChildren(node)}
      lines={propNumber(node, 'lines')}
      style={[
        type.caption,
        {
          color: toneInk(node.props?.tone ?? 'dimmed', c.inkSoft),
          textAlign: ALIGN_TEXT[propString(node, 'align') ?? 'start'],
        },
      ]}
    />
  );
}

function Badge({ node }: { node: ContentNode }) {
  return (
    <Tag
      label={inlineText(nodeChildren(node))}
      tone={tagTone(node.props?.tone)}
    />
  );
}

function IconBlock({ node }: { node: ContentNode }) {
  const glyph = cardIconGlyph(propString(node, 'name'));
  return glyph ? (
    <Glyph
      name={glyph}
      size={16}
      color={toneInk(node.props?.tone, c.inkSoft)}
    />
  ) : null;
}

function Progress({ node }: { node: ContentNode }) {
  const accent = useAccent();
  const label = propString(node, 'label');
  const value = propString(node, 'value');
  const percent = Math.min(100, Math.max(0, propNumber(node, 'percent') ?? 0));
  return (
    <View style={{ gap: 6 }}>
      {label || value ? (
        <View style={styles.progressHead}>
          <Text style={[type.small, { flex: 1, color: c.ink }]}>
            {label ?? ''}
          </Text>
          {value ? (
            <Text style={[type.mono, { color: c.ink }]}>{value}</Text>
          ) : null}
        </View>
      ) : null}
      <View
        style={styles.track}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: Math.round(percent),
          text: value,
        }}
      >
        <View
          style={[
            styles.fill,
            {
              width: `${percent}%`,
              backgroundColor: rampOf(node.props?.tone)?.fill ?? accent.fill,
            },
          ]}
        />
      </View>
    </View>
  );
}

function Stat({ node }: { node: ContentNode }) {
  const delta = propString(node, 'delta');
  return (
    <View style={styles.stat}>
      <Text style={type.caption}>{propString(node, 'label') ?? ''}</Text>
      <Text
        style={[type.heading, { fontWeight: weights.heading }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {propString(node, 'value') ?? ''}
      </Text>
      {delta ? (
        <Text
          style={[
            type.caption,
            { color: toneInk(node.props?.tone, c.inkSoft) },
          ]}
        >
          {delta}
        </Text>
      ) : null}
    </View>
  );
}

function Fields({ node }: { node: ContentNode }) {
  const mono = propBool(node, 'mono');
  return (
    <View style={{ gap: 6 }}>
      {resolveChildren(nodeChildren(node)).map((child, index) =>
        isNode(child) && child.type === 'Field' ? (
          <View key={index} style={styles.field}>
            <Text style={[type.small, styles.fieldLabel]}>
              {propString(child, 'label') ?? ''}
            </Text>
            <Paragraph
              nodes={nodeChildren(child)}
              style={[
                paragraph,
                { flex: 1, fontSize: 14, lineHeight: 20 },
                (mono || propBool(child, 'mono')) && {
                  fontFamily: fonts.mono,
                  fontSize: 13,
                },
              ]}
            />
          </View>
        ) : isNode(child) ? (
          <Block key={index} node={child} />
        ) : null,
      )}
    </View>
  );
}

const STEP: Record<string, { glyph: GlyphName; word: string }> = {
  done: { glyph: 'check', word: 'Done' },
  failed: { glyph: 'close', word: 'Failed' },
  running: { glyph: 'refresh', word: 'Running' },
  pending: { glyph: 'circle', word: 'Pending' },
  skipped: { glyph: 'minus', word: 'Skipped' },
};

function stepColor(state: string): string {
  if (state === 'done') return status.success.fill;
  if (state === 'failed') return status.danger.fill;
  if (state === 'running') return status.info.fill;
  return c.inkSoft;
}

function Steps({ node }: { node: ContentNode }) {
  const env = useContext(Env);
  const mono = propBool(node, 'mono');
  const steps = resolveChildren(nodeChildren(node)).filter(
    (child): child is ContentNode => isNode(child) && child.type === 'Step',
  );
  return (
    <View style={mono ? styles.checks : { gap: 2 }}>
      {steps.map((step, index) => {
        const state = propString(step, 'state') ?? 'pending';
        const known = STEP[state] ?? STEP.pending!;
        const detail = propString(step, 'detail');
        const at = propString(step, 'at');
        const href = propString(step, 'href');
        const row = (
          <View
            style={[
              styles.step,
              mono && index > 0 && styles.checkDivider,
              mono && { paddingHorizontal: 12 },
            ]}
          >
            <Glyph name={known.glyph} size={13} color={stepColor(state)} />
            <Paragraph
              nodes={nodeChildren(step)}
              style={[
                paragraph,
                { flex: 1, fontSize: 14, lineHeight: 20 },
                state === 'skipped' && { color: c.inkSoft },
                mono && { fontFamily: fonts.mono, fontSize: 13 },
              ]}
            />
            {detail || at ? (
              <Text style={[type.caption, { flexShrink: 0, maxWidth: '40%' }]}>
                {[detail, at ? contentTime(at, 'step') : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : null}
            {href ? <Glyph name="open" size={11} color={c.inkSoft} /> : null}
          </View>
        );
        const label = `${known.word}: ${inlineText(nodeChildren(step))}`;
        return href ? (
          <Pressable
            key={index}
            accessibilityRole="link"
            accessibilityLabel={label}
            onPress={() => env.open(href)}
            style={({ pressed }) => pressed && { backgroundColor: c.hover }}
          >
            {row}
          </Pressable>
        ) : (
          <View key={index} accessible accessibilityLabel={label}>
            {row}
          </View>
        );
      })}
    </View>
  );
}

function List({ node }: { node: ContentNode }) {
  const accent = useAccent();
  const ordered = propBool(node, 'ordered');
  const items = resolveChildren(nodeChildren(node)).filter(
    (child): child is ContentNode => isNode(child) && child.type === 'Item',
  );
  return (
    <View style={{ gap: 6 }}>
      {items.map((item, index) => {
        const checked = item.props?.checked;
        return (
          <View key={index} style={styles.item}>
            {typeof checked === 'boolean' ? (
              <View
                accessible
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                style={styles.marker}
              >
                <Glyph
                  name={checked ? 'checkSquare' : 'square'}
                  size={14}
                  color={checked ? accent.fill : c.inkSoft}
                />
              </View>
            ) : (
              <Text style={[paragraph, styles.marker, { color: c.inkSoft }]}>
                {ordered ? `${index + 1}.` : '•'}
              </Text>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Blocks nodes={nodeChildren(item)} gap={6} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function Table({ node }: { node: ContentNode }) {
  const rows = resolveChildren(nodeChildren(node)).filter(
    (child): child is ContentNode => isNode(child) && child.type === 'Tr',
  );
  return (
    <View style={styles.table}>
      {rows.map((row, rowIndex) => {
        const cells = resolveChildren(nodeChildren(row)).filter(
          (child): child is ContentNode =>
            isNode(child) && (child.type === 'Th' || child.type === 'Td'),
        );
        const header =
          cells.length > 0 && cells.every((cell) => cell.type === 'Th');
        return (
          <View
            key={rowIndex}
            style={[
              styles.tableRow,
              rowIndex > 0 && styles.checkDivider,
              header && { backgroundColor: c.muted },
            ]}
          >
            {cells.map((cell, cellIndex) => (
              <View key={cellIndex} style={styles.cell}>
                <Paragraph
                  header={cell.type === 'Th'}
                  nodes={nodeChildren(cell)}
                  style={[
                    paragraph,
                    { fontSize: 13, lineHeight: 18 },
                    cell.type === 'Th' && { fontWeight: weights.heading },
                    {
                      textAlign:
                        ALIGN_TEXT[propString(cell, 'align') ?? 'start'],
                    },
                  ]}
                />
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function Quote({ node }: { node: ContentNode }) {
  const author = propString(node, 'author');
  const location = propString(node, 'location');
  return (
    <View style={styles.quote}>
      {author || location ? (
        <Text style={type.caption}>
          {author ? (
            <NativeText style={{ color: c.ink, fontWeight: weights.heading }}>
              {author}
            </NativeText>
          ) : null}
          {author && location ? ' · ' : ''}
          {location ?? ''}
        </Text>
      ) : null}
      <Blocks nodes={nodeChildren(node)} gap={6} />
    </View>
  );
}

const DIFF: Record<string, { color?: string; backgroundColor?: string }> = {
  added: { color: status.success.ink, backgroundColor: status.success.tint },
  removed: { color: status.danger.ink, backgroundColor: status.danger.tint },
  hunk: { color: status.info.ink },
  plain: {},
};

function Code({ node }: { node: ContentNode }) {
  const { selectable } = useContext(Env);
  return (
    <View style={styles.code}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ paddingVertical: 10 }}>
          {codeLines(node).map((line, index) => (
            <Text
              key={index}
              selectable={selectable}
              style={[
                type.mono,
                styles.codeLine,
                { color: c.ink },
                DIFF[line.kind],
              ]}
            >
              {line.text || ' '}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Trend({ node }: { node: ContentNode }) {
  const accent = useAccent();
  const raw = node.props?.values;
  const values = Array.isArray(raw) ? raw : [];
  const threshold = propNumber(node, 'threshold');
  const unit = propString(node, 'unit') ?? '';
  const label = propString(node, 'label');
  const chart = trendBars(values, threshold);
  // A currency sign goes before the figure, a unit such as "ms" after it.
  const show = (value: number) =>
    /^\p{Sc}$/u.test(unit)
      ? `${unit}${value}`
      : `${value}${unit && ` ${unit}`}`;
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={type.caption}>{label}</Text> : null}
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${label ?? 'Trend'}: ${values.map(show).join(', ')}${
          threshold === undefined ? '' : `; threshold ${show(threshold)}`
        }`}
        style={styles.trend}
      >
        {chart.bars.map((bar, index) => (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: `${Math.max(bar.ratio * 100, 3)}%`,
                backgroundColor: bar.over
                  ? status.danger.fill
                  : accent.tintStrong,
              },
            ]}
          />
        ))}
        {chart.threshold !== null ? (
          <View
            pointerEvents="none"
            style={[styles.threshold, { bottom: `${chart.threshold * 100}%` }]}
          />
        ) : null}
      </View>
    </View>
  );
}

function Callout({ node }: { node: ContentNode }) {
  const ramp = rampOf(node.props?.tone);
  const title = propString(node, 'title');
  return (
    <View style={[styles.callout, { backgroundColor: ramp?.tint ?? c.muted }]}>
      {title ? (
        <Text
          style={[
            paragraph,
            { fontWeight: weights.heading, color: ramp?.ink ?? c.ink },
          ]}
        >
          {title}
        </Text>
      ) : null}
      <Blocks
        nodes={nodeChildren(node)}
        gap={6}
        textStyle={{ ...paragraph, fontSize: 14, lineHeight: 20 }}
      />
    </View>
  );
}

function Question({ node }: { node: ContentNode }) {
  const env = useContext(Env);
  const { field, form } = useBoundField(node);
  if (!field) return null;
  return (
    <ReplyFieldInput
      field={field}
      form={form}
      chosen={env.chosen}
      markOptional={false}
    />
  );
}

function LinkButton({ node }: { node: ContentNode }) {
  const env = useContext(Env);
  const href = propString(node, 'href');
  // An answer button outside its Buttons has nothing to answer.
  if (!href) return null;
  return (
    <ButtonStack
      buttons={[
        {
          key: href,
          label: inlineText(nodeChildren(node)) || href,
          variant: 'muted',
          trailingGlyph: 'open',
          onPress: () => env.open(href),
        },
      ]}
    />
  );
}

function Submit({ node }: { node: ContentNode }) {
  const { form, reply } = useContext(Env);
  if (!form || !reply) return null;
  return (
    <SubmitButton
      form={form}
      label={inlineText(nodeChildren(node)) || reply.submitLabel}
    />
  );
}

/**
 * A row or column that holds buttons. A phone stacks them one per line, at
 * least 44 points each: the main action first, links last.
 */
function ButtonRow({ node }: { node: ContentNode }) {
  const env = useContext(Env);
  const { questions, buttons, others } = stackButtons(nodeChildren(node));
  const fieldOf = (fieldId: string) =>
    env.reply?.fields.find((field) => field.id === fieldId) ?? null;
  const stacked: StackedButton[] = [];
  for (const item of buttons) {
    if (item.kind === 'link') {
      stacked.push({
        key: `link:${item.href}:${stacked.length}`,
        label: inlineText(nodeChildren(item.node)) || item.href,
        variant: 'muted',
        trailingGlyph: 'open',
        onPress: () => env.open(item.href),
      });
    } else if (item.kind === 'submit') {
      const { form, reply } = env;
      if (!form || !reply) continue;
      stacked.push({
        key: 'submit',
        label: form.busy
          ? 'Sending answer…'
          : inlineText(nodeChildren(item.node)) || reply.submitLabel,
        variant: 'primary',
        glyph: 'send',
        disabled: form.busy,
        onPress: form.submit,
      });
    } else {
      const field = fieldOf(item.fieldId);
      const button = field
        ? answerButtons(field, env.form, env.chosen).find(
            (entry) => entry.key === item.optionId,
          )
        : undefined;
      if (button)
        stacked.push({ ...button, key: `${item.fieldId}:${button.key}` });
    }
  }
  return (
    <View style={{ gap: 10 }}>
      {others.length > 0 ? <Blocks nodes={others} /> : null}
      {questions.map((question, index) => {
        const field = fieldOf(propString(question, 'id') ?? '');
        return field ? (
          <ReplyFieldInput
            key={index}
            field={field}
            form={env.form}
            chosen={env.chosen}
            buttons={false}
            markOptional={false}
          />
        ) : null;
      })}
      {stacked.length > 0 ? <ButtonStack buttons={stacked} /> : null}
    </View>
  );
}

/** Every block the catalog has; the type checker holds this complete. */
const BLOCKS: Record<BlockType, BlockRenderer> = {
  Card: Root,
  Document: Root,
  Column,
  Row,
  Grid,
  Box,
  Divider,
  Spacer,
  Collapse,
  Title,
  Text: TextBlock,
  Caption,
  Markdown: Root,
  Badge,
  Icon: IconBlock,
  Progress,
  Stat,
  Fields,
  Steps,
  List,
  Table,
  Quote,
  Code,
  Trend,
  Callout,
  Choice: Question,
  Buttons: Question,
  Button: LinkButton,
  Input: Question,
  Submit,
};

// ------------------------------------------------------------------ frame

const NO_FORM: ReplyForm = { fields: [], submitLabel: '' };

/**
 * A Markdown or card notification's content. A card shows its status and
 * flag at the top (after an answer, the chosen option's then-status, until
 * the sender edits it again). Inline questions are one form bound to the
 * notification's reply: live while `respond` is given and nobody answered,
 * read-only showing the answer after. The caller draws the "who answered"
 * line below, in its fixed place.
 */
export function NotificationContent({
  content,
  reply,
  answer,
  editedAt,
  respond,
  selectable = false,
}: {
  content: ContentNode;
  reply: ReplyForm | null;
  /** The answer to the round this content asks. */
  answer: NotificationAnswer | null;
  editedAt: string | null;
  respond?: {
    busy: boolean;
    onSubmit: (answers: ReplyAnswers) => void;
  } | null;
  selectable?: boolean;
}) {
  const open = useOpenNotificationUrl();
  const inline = inlineForm(content, reply);
  const live = Boolean(inline && respond && !answer);
  const form = useReplyForm(reply ?? NO_FORM, {
    busy: respond?.busy ?? false,
    onSubmit: (answers) => respond?.onSubmit(answers),
  });
  const head = answeredCardHead({
    content,
    answers: answer?.answers,
    respondedAt: answer?.respondedAt,
    editedAt,
  });
  const env: ContentEnv = {
    form: live ? form : null,
    reply,
    chosen: answer ? answer.answers : null,
    selectable,
    open,
  };
  return (
    <Env value={env}>
      <View style={{ gap: 12 }}>
        {content.type === CARD_ROOT && (head.status || head.flag) ? (
          <View style={styles.head}>
            {head.status ? (
              <Tag
                dot
                label={head.status.label}
                tone={tagTone(head.status.tone)}
              />
            ) : null}
            {head.flag ? (
              <View style={styles.flag}>
                <Text maxFontSizeMultiplier={1.6} style={styles.flagText}>
                  {head.flag}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <Blocks nodes={nodeChildren(content)} />
        {live && inline?.addSubmit && reply ? (
          <SubmitButton form={form} label={reply.submitLabel} />
        ) : null}
        {live ? <FormError form={form} /> : null}
      </View>
    </Env>
  );
}

/** Whether the card asks its questions inside itself. */
export function asksInline(
  content: ContentNode | null,
  reply: ReplyForm | null,
): boolean {
  return inlineForm(content, reply) !== null;
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  flag: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: pill,
    backgroundColor: status.danger.fill,
  },
  flagText: {
    color: c.onFill,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: weights.heading,
  },
  markers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.hairline,
  },
  collapse: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderRadius: radii.sm,
  },
  progressHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  track: {
    height: 6,
    borderRadius: pill,
    backgroundColor: c.hover,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: pill },
  stat: {
    // Fills a grid cell, so stats in one row share a height.
    flexGrow: 1,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: c.muted,
  },
  field: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  fieldLabel: { width: '30%', minWidth: 56, maxWidth: 120 },
  checks: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hairline,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  checkDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 36,
    paddingVertical: 6,
  },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  marker: { minWidth: 18 },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hairline,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  tableRow: { flexDirection: 'row' },
  cell: { flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 8 },
  quote: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: c.muted,
  },
  code: {
    borderRadius: radii.md,
    backgroundColor: c.muted,
    overflow: 'hidden',
  },
  codeLine: { paddingHorizontal: 12 },
  trend: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  bar: {
    flex: 1,
    borderTopLeftRadius: radii.xs,
    borderTopRightRadius: radii.xs,
  },
  threshold: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 0,
    // iOS dashes only a border drawn on every side.
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: status.danger.fill,
  },
  callout: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
  },
});
