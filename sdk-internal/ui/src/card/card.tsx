/**
 * The card itself, and the cards an App shows from markup or a tree: the
 * same render tree a notification's card compiles into, drawn with the
 * components of `parts.tsx` and `inputs.tsx`.
 */
import { View, signal } from 'nsh';
import { Each } from '../core/control';
import type { JSX } from 'nsh';
import { SurfaceContext } from '../core/surface';
import { FieldErrorLine } from '../input/Field';
import {
  CONTENT_TONES,
  cardHead,
  componentSpec,
  inlineText,
  isNode,
  nodeChildren,
  propNumber,
  propString,
  walkContent,
} from './content/catalog.gen';
import type {
  CardIconName,
  ContentChild,
  ContentNode,
  ContentTone,
} from './content/catalog.gen';
import {
  ContentError,
  compileCardJsonWith,
  compileCardMarkupWith,
  compileMarkdownWith,
} from './content/compile.gen';
import type {
  CompiledCard,
  ContentIssue,
  JsonNode,
} from './content/compile.gen';
import { CardContext, createCardScope } from './form';
import type { CardAnswerProps, CardTransition, CompiledForm } from './form';
import {
  Button,
  Buttons,
  Choice,
  Input,
  Option,
  Submit,
  SubmitButton,
} from './inputs';
import type {
  ButtonProps,
  ButtonsProps,
  ChoiceProps,
  InputProps,
  OptionProps,
} from './inputs';
import { markdownToBlocks } from './markdown';
import {
  Badge,
  Bold,
  Box,
  Callout,
  Caption,
  CardHead,
  CardWidthContext,
  Code,
  Collapse,
  Column,
  Divider,
  Field,
  Fields,
  Grid,
  Icon,
  InlineCode,
  Italic,
  Item,
  LineBreak,
  Link,
  List,
  Progress,
  Quote,
  Row,
  Spacer,
  Stat,
  Step,
  Steps,
  Strike,
  Table,
  Td,
  Text,
  Th,
  Time,
  Title,
  Tr,
  Trend,
} from './parts';
import type {
  BoxProps,
  CalloutProps,
  CaptionProps,
  CellProps,
  CodeProps,
  CollapseProps,
  ColumnProps,
  FieldProps,
  FieldsProps,
  GridProps,
  ItemProps,
  ListProps,
  ProgressProps,
  QuoteProps,
  RowProps,
  SpacerProps,
  StatProps,
  StepProps,
  StepsProps,
  TextProps,
  TitleProps,
  TrendProps,
} from './parts';
import { FRAME } from './styles';

export type CardProps = CardAnswerProps & {
  /** The card's content. */
  children?: JSX.Element;
  /** Shown at the start of the card's head. */
  icon?: CardIconName;
  /** A short state shown as a pill, such as "CI failed". */
  status?: string;
  /** Tone of the status; default `neutral`. */
  tone?: ContentTone;
  /** An urgent marker beside the status, such as "Urgent". */
  flag?: string;
};

/** A card. Its questions (`Choice`, `Buttons`, `Input`) are one form whose
 * answers reach `onSubmit`. A card written in TSX is drawn, not stored:
 * to send or store a card, write it as markup. */
export function Card(props: CardProps): JSX.Element {
  return (
    <CardFrame {...props} compiled={null}>
      {props.children}
    </CardFrame>
  );
}

function CardFrame(
  props: CardProps & { compiled: CompiledForm | null },
): JSX.Element {
  const scope = createCardScope(props, () => props.compiled);
  const width = signal(Number.POSITIVE_INFINITY);
  const status = (): CardTransition | null =>
    scope.transition() ??
    (props.status
      ? { label: props.status, tone: props.tone ?? 'neutral' }
      : null);
  return (
    <CardContext.Provider value={scope}>
      <CardWidthContext.Provider value={() => width()}>
        <SurfaceContext.Provider value="card">
          <View
            class={FRAME}
            onLayout={(event) => width.set(event.bounds.size.width)}
          >
            <CardHead
              icon={props.icon}
              status={status()}
              flag={scope.mode() === 'answered' ? null : props.flag}
            />
            {props.children}
            {scope.mode() === 'live' && scope.needsSubmit() ? (
              <View class={width() < 400 ? 'items-stretch' : 'items-start'}>
                <SubmitButton card={scope} />
              </View>
            ) : null}
            <FieldErrorLine error={scope.formError()} />
          </View>
        </SurfaceContext.Provider>
      </CardWidthContext.Provider>
    </CardContext.Provider>
  );
}

// --------------------------------------------------------------- renderer

/** A node's props as its component takes them: `then-status` is
 * `thenStatus`. The compiler held them to the catalog, which the
 * components' props follow. */
function propsOf<T>(node: ContentNode): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props ?? {})) {
    out[
      name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    ] = value;
  }
  return out as T;
}

/** Inline content: text and inline marks. */
function isInline(child: ContentChild): boolean {
  if (typeof child === 'string') return true;
  return componentSpec(child.type)?.placement === 'inline';
}

/** Inline content as spans of the paragraph it is in. */
function renderInline(children: readonly ContentChild[]): JSX.Element {
  return children.map((child) =>
    typeof child === 'string' ? child : renderInlineNode(child),
  );
}

function renderInlineNode(node: ContentNode): JSX.Element {
  const children = nodeChildren(node);
  switch (node.type) {
    case 'b':
      return <Bold>{renderInline(children)}</Bold>;
    case 'i':
      return <Italic>{renderInline(children)}</Italic>;
    case 's':
      return <Strike>{renderInline(children)}</Strike>;
    case 'code':
      return <InlineCode>{inlineText(children)}</InlineCode>;
    case 'br':
      return <LineBreak />;
    case 'a':
      return (
        <Link href={propString(node, 'href') ?? ''}>
          {renderInline(children)}
        </Link>
      );
    case 'time':
      return (
        <Time
          datetime={propString(node, 'datetime') ?? ''}
          format={propString(node, 'format') as 'datetime' | 'date' | 'time'}
        />
      );
    case 'Badge':
      return <Badge tone={tone(node)}>{inlineText(children)}</Badge>;
    case 'Icon':
      return (
        <Icon
          name={propString(node, 'name') as CardIconName}
          tone={tone(node)}
        />
      );
    default:
      return children.length > 0 ? renderInline(children) : null;
  }
}

function tone(node: ContentNode, name = 'tone'): ContentTone | undefined {
  const value = propString(node, name);
  return (CONTENT_TONES as readonly string[]).includes(value ?? '')
    ? (value as ContentTone)
    : undefined;
}

/** Block children, loose inline runs gathered into paragraphs. */
function renderBlocks(children: readonly ContentChild[]): JSX.Element {
  const groups: (ContentNode | ContentChild[])[] = [];
  for (const child of children) {
    const last = groups.at(-1);
    if (isInline(child)) {
      if (Array.isArray(last)) last.push(child);
      else groups.push([child]);
    } else {
      groups.push(child as ContentNode);
    }
  }
  return groups.map((group) =>
    Array.isArray(group) ? paragraph(group) : renderBlock(group),
  );
}

/** A run of inline content among blocks, as a paragraph. */
function paragraph(children: readonly ContentChild[]): JSX.Element {
  return <Text>{renderInline(children)}</Text>;
}

/** Content of a flow part (a list item, quote or callout). */
function renderFlow(children: readonly ContentChild[]): JSX.Element {
  return children.every(isInline)
    ? renderInline(children)
    : renderBlocks(children);
}

function parts(node: ContentNode, type: string): ContentNode[] {
  return nodeChildren(node)
    .filter(isNode)
    .filter((child) => child.type === type);
}

function tableCell(cell: ContentNode): JSX.Element {
  if (cell.type === 'Th') {
    return (
      <Th {...propsOf<CellProps>(cell)}>{renderInline(nodeChildren(cell))}</Th>
    );
  }
  if (cell.type === 'Td') {
    return (
      <Td {...propsOf<CellProps>(cell)}>{renderInline(nodeChildren(cell))}</Td>
    );
  }
  return null;
}

function renderBlock(node: ContentNode): JSX.Element {
  const children = nodeChildren(node);
  switch (node.type) {
    case 'Column':
      return (
        <Column {...propsOf<ColumnProps>(node)}>
          {renderBlocks(children)}
        </Column>
      );
    case 'Row':
      return <Row {...propsOf<RowProps>(node)}>{renderBlocks(children)}</Row>;
    case 'Grid':
      return (
        <Grid {...propsOf<GridProps>(node)}>{renderBlocks(children)}</Grid>
      );
    case 'Box':
      return <Box {...propsOf<BoxProps>(node)}>{renderBlocks(children)}</Box>;
    case 'Divider':
      return <Divider />;
    case 'Spacer':
      return <Spacer {...propsOf<SpacerProps>(node)} />;
    case 'Collapse':
      return (
        <Collapse {...propsOf<CollapseProps>(node)}>
          {renderBlocks(children)}
        </Collapse>
      );
    case 'Title':
      return (
        <Title {...propsOf<TitleProps>(node)}>{renderInline(children)}</Title>
      );
    case 'Text':
      return (
        <Text {...propsOf<TextProps>(node)}>{renderInline(children)}</Text>
      );
    case 'Caption':
      return (
        <Caption {...propsOf<CaptionProps>(node)}>
          {renderInline(children)}
        </Caption>
      );
    case 'Markdown':
      // Compiled with the card: its blocks are the children.
      return <View class="gap-2.5">{renderBlocks(children)}</View>;
    case 'Badge':
    case 'Icon':
      return <View class="flex-row">{renderInlineNode(node)}</View>;
    case 'Progress':
      return (
        <Progress
          {...propsOf<ProgressProps>(node)}
          percent={propNumber(node, 'percent') ?? 0}
          tone={tone(node)}
        />
      );
    case 'Stat':
      return <Stat {...propsOf<StatProps>(node)} />;
    case 'Fields':
      return (
        <Fields {...propsOf<FieldsProps>(node)}>
          <Each of={parts(node, 'Field')} key="index">
            {(field) => (
              <Field {...propsOf<FieldProps>(field())}>
                {renderInline(nodeChildren(field()))}
              </Field>
            )}
          </Each>
        </Fields>
      );
    case 'Steps':
      return (
        <Steps {...propsOf<StepsProps>(node)}>
          <Each of={parts(node, 'Step')} key="index">
            {(step) => (
              <Step {...propsOf<StepProps>(step())}>
                {renderInline(nodeChildren(step()))}
              </Step>
            )}
          </Each>
        </Steps>
      );
    case 'List':
      return (
        <List {...propsOf<ListProps>(node)}>
          <Each of={parts(node, 'Item')} key="index">
            {(item) => (
              <Item {...propsOf<ItemProps>(item())}>
                {renderFlow(nodeChildren(item()))}
              </Item>
            )}
          </Each>
        </List>
      );
    case 'Table':
      return (
        <Table>
          <Each of={parts(node, 'Tr')} key="index">
            {(row) => (
              <Tr>
                <Each of={nodeChildren(row()).filter(isNode)} key="index">
                  {(cell) => tableCell(cell())}
                </Each>
              </Tr>
            )}
          </Each>
        </Table>
      );
    case 'Quote':
      return (
        <Quote {...propsOf<QuoteProps>(node)}>{renderFlow(children)}</Quote>
      );
    case 'Code':
      return <Code {...propsOf<CodeProps>(node)}>{inlineText(children)}</Code>;
    case 'Trend': {
      const values = node.props?.values;
      return (
        <Trend
          {...propsOf<TrendProps>(node)}
          values={Array.isArray(values) ? values : []}
        />
      );
    }
    case 'Callout':
      return (
        <Callout {...propsOf<CalloutProps>(node)} tone={tone(node)}>
          {renderFlow(children)}
        </Callout>
      );
    case 'Choice':
      return (
        <Choice {...propsOf<ChoiceProps>(node)}>
          <Each of={parts(node, 'Option')} key="index">
            {(option) => (
              <Option {...propsOf<OptionProps>(option())}>
                {inlineText(nodeChildren(option()))}
              </Option>
            )}
          </Each>
        </Choice>
      );
    case 'Buttons':
      return (
        <Buttons {...propsOf<ButtonsProps>(node)}>
          <Each of={parts(node, 'Button')} key="index">
            {(button) => (
              <Button {...propsOf<ButtonProps>(button())}>
                {inlineText(nodeChildren(button()))}
              </Button>
            )}
          </Each>
        </Buttons>
      );
    case 'Button':
      // An answer button belongs in Buttons; alone it can only be a link.
      return propString(node, 'href') ? (
        <Button href={propString(node, 'href')}>{inlineText(children)}</Button>
      ) : null;
    case 'Input':
      return <Input {...propsOf<InputProps>(node)} />;
    case 'Submit':
      return <Submit>{inlineText(children)}</Submit>;
    default:
      // A type this build does not know: its children take its place.
      if (children.length === 0) return null;
      return isInline(node) ? (
        <Text>{renderInlineNode(node)}</Text>
      ) : (
        renderBlocks(children)
      );
  }
}

/** The statuses a compiled card's options put on it, by field. */
function compiledForm(card: CompiledCard): CompiledForm {
  const transitions = new Map<string, Record<string, CardTransition>>();
  for (const { node } of walkContent(card.content)) {
    if (node.type !== 'Choice' && node.type !== 'Buttons') continue;
    const fieldId = propString(node, 'id');
    if (!fieldId) continue;
    const options: Record<string, CardTransition> = {};
    for (const option of nodeChildren(node).filter(isNode)) {
      const optionId = propString(option, 'id');
      const label = propString(option, 'then-status');
      if (optionId && label) {
        options[optionId] = {
          label,
          tone: tone(option, 'then-tone') ?? 'neutral',
        };
      }
    }
    transitions.set(fieldId, options);
  }
  return { form: card.reply, transitions };
}

/** A compiled card drawn whole. */
function CompiledCardView(
  props: CardAnswerProps & { card: CompiledCard },
): JSX.Element {
  const head = cardHead(props.card.content);
  return (
    <CardFrame
      {...props}
      compiled={compiledForm(props.card)}
      icon={head.icon ?? undefined}
      status={head.status?.label}
      tone={head.status?.tone}
      flag={head.flag ?? undefined}
    >
      {renderBlocks(nodeChildren(props.card.content))}
    </CardFrame>
  );
}

const OPTIONS = { markdownToBlocks };

export type MarkdownProps = {
  /** The Markdown: headings, emphasis, lists, quotes, code, links and
   * tables. */
  children?: string;
};

/** Markdown inside a card, read as the platform reads it. */
export function Markdown(props: MarkdownProps): JSX.Element {
  const blocks = () => {
    try {
      return nodeChildren(compileMarkdownWith(props.children ?? '', OPTIONS));
    } catch (error) {
      if (error instanceof ContentError) return [];
      throw error;
    }
  };
  return <View class="gap-2.5">{renderBlocks(blocks())}</View>;
}

/** Compiles card markup or a tree as the platform does: the tree and its
 * form, or the problems that make it unusable (`line:column` for markup,
 * a path for a tree). */
export function compileCard(
  source: string | ContentNode,
):
  | { ok: true; content: ContentNode; reply: CompiledCard['reply'] }
  | { ok: false; issues: ContentIssue[] } {
  try {
    const card =
      typeof source === 'string'
        ? compileCardMarkupWith(source, OPTIONS)
        : compileCardJsonWith(jsonTree(source), OPTIONS);
    return { ok: true, content: card.content, reply: card.reply };
  } catch (error) {
    if (error instanceof ContentError)
      return { ok: false, issues: error.issues };
    throw error;
  }
}

/** A tree read leniently: what is not shaped like a node becomes nothing,
 * which the compiler then reports. */
function jsonTree(value: unknown): JsonNode {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const props =
    typeof record.props === 'object' &&
    record.props !== null &&
    !Array.isArray(record.props)
      ? (record.props as Record<string, unknown>)
      : undefined;
  const children = Array.isArray(record.children)
    ? record.children.map((child) =>
        typeof child === 'string' ? child : jsonTree(child),
      )
    : undefined;
  return {
    type: typeof record.type === 'string' ? record.type : '',
    ...(props ? { props } : {}),
    ...(children ? { children } : {}),
  };
}

export type CardMarkupProps = CardAnswerProps & {
  /** Card markup, as `hatch notification card catalog` lists it, such as
   * an Agent or the App's backend wrote. */
  source: string;
  /** Called with the problems when the markup cannot be shown. */
  onError?: (issues: ContentIssue[]) => void;
  /** Shown in place of an unusable card; default a short notice with the
   * first problems. */
  fallback?: JSX.Element;
};

/** A card from markup, drawn as the Desk and the phone draw a notification
 * card. */
export function CardMarkup(props: CardMarkupProps): JSX.Element {
  return <CompiledSource {...props} source={props.source} />;
}

export type CardTreeProps = CardAnswerProps & {
  /** A card's render tree, such as a notification's stored content. */
  tree: ContentNode;
  /** Called with the problems when the tree cannot be shown. */
  onError?: (issues: ContentIssue[]) => void;
  /** Shown in place of an unusable card. */
  fallback?: JSX.Element;
};

/** A card from its render tree. */
export function CardTree(props: CardTreeProps): JSX.Element {
  return <CompiledSource {...props} source={props.tree} />;
}

function CompiledSource(
  props: CardAnswerProps & {
    source: string | ContentNode;
    onError?: (issues: ContentIssue[]) => void;
    fallback?: JSX.Element;
  },
): JSX.Element {
  const result = () => compileCard(props.source);
  const shown = () => {
    const compiled = result();
    if (compiled.ok) {
      return (
        <CompiledCardView
          {...props}
          card={{ content: compiled.content, reply: compiled.reply }}
        />
      );
    }
    props.onError?.(compiled.issues);
    return props.fallback ?? <InvalidCard issues={compiled.issues} />;
  };
  return <>{shown()}</>;
}

function InvalidCard(props: { issues: ContentIssue[] }): JSX.Element {
  return (
    <View class={FRAME}>
      <Callout tone="danger" title="This card cannot be shown">
        {props.issues
          .slice(0, 3)
          .map((issue) =>
            issue.line !== undefined
              ? `${issue.line}:${issue.column}: ${issue.message}`
              : issue.path
                ? `${issue.path}: ${issue.message}`
                : issue.message,
          )
          .join('\n')}
      </Callout>
    </View>
  );
}
