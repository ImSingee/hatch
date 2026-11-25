/**
 * A Markdown or card notification's content: the render tree both compile
 * into, drawn with Desk tokens. Cards also get their status and flag, drawn
 * by the platform in a fixed place above the sender's content, and their
 * inline inputs, answered in place as one form. Text notifications keep
 * their title and body, which each surface draws itself.
 *
 * Types this client does not know render their children when they have
 * any and are skipped otherwise, so a newer sender never breaks the page.
 */
import { Checkbox, Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconApps,
  IconBug,
  IconCheck,
  IconChevronRight,
  IconCircle,
  IconCoin,
  IconDatabase,
  IconGitPullRequest,
  IconListCheck,
  IconLoader2,
  IconMessage,
  IconMinus,
  IconPackage,
  IconRocket,
  IconShield,
  IconSparkles,
  IconClock,
  IconX,
  type Icon,
} from '@tabler/icons-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  CARD_ROOT,
  cardHead,
  componentSpec,
  hasInlineInputs,
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  type CardHead,
  type CardIconName,
  type ContentChild,
  type ContentNode,
  type NotificationFormat,
} from '../../../packages/hatch-platform-api/notification-content';
import type {
  ReplyAnswers,
  ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { useI18n, type Locale, type PlainTranslationKey } from '~i18n';
import { formatExact } from '~lib/format';
import { notificationLinkTarget } from './notification-link';
import {
  ButtonsInput,
  ChoiceInput,
  InlineFormProvider,
  LinkButton,
  LiveInlineForm,
  SubmitInput,
  TextAnswerInput,
} from './notification-content-inputs';
import classes from './notification-content-view.module.css';

// ------------------------------------------------------------------ frame

/**
 * The content of a Markdown or card notification; null for a text one.
 * `form` answers the card's inline inputs here; without it they show
 * `answers` (the round's answer) read-only, or their defaults.
 */
export function NotificationContent({
  format,
  content,
  head,
  form,
  answers,
}: {
  format: NotificationFormat;
  content: ContentNode | null;
  /** Status and flag in the card's fixed place; the card's own by default. */
  head?: CardHead;
  form?: { notificationId: string; reply: ReplyForm; round: number } | null;
  answers?: ReplyAnswers | null;
}) {
  if (format === 'text' || !content) return null;
  const tree = <ContentRoot node={content} head={head ?? cardHead(content)} />;
  if (form && hasInlineInputs(content)) {
    return (
      <LiveInlineForm
        // A new question is a new form: no draft carries over.
        key={`${form.notificationId}:${form.round}`}
        notificationId={form.notificationId}
        reply={form.reply}
        round={form.round}
        content={content}
      >
        {tree}
      </LiveInlineForm>
    );
  }
  return (
    <InlineFormProvider
      value={{ control: null, answers: answers ?? null, reply: null }}
    >
      {tree}
    </InlineFormProvider>
  );
}

function ContentRoot({ node, head }: { node: ContentNode; head: CardHead }) {
  if (node.type === CARD_ROOT) {
    return (
      <div className={classes.card}>
        <CardHeadView head={head} />
        <Blocks nodes={nodeChildren(node)} />
      </div>
    );
  }
  return (
    <div className={classes.document}>
      <Blocks nodes={nodeChildren(node)} />
    </div>
  );
}

/** The card's status pill and urgent flag, drawn by the platform. */
export function CardHeadView({ head }: { head: CardHead }) {
  if (!head.status && !head.flag) return null;
  return (
    <div className={classes.head}>
      {head.status ? (
        <span className={classes.status} data-tone={head.status.tone}>
          <span className={classes.dot} aria-hidden />
          {head.status.label}
        </span>
      ) : null}
      {head.flag ? <span className={classes.flag}>{head.flag}</span> : null}
    </div>
  );
}

const ICONS: Record<CardIconName, Icon> = {
  agent: IconSparkles,
  app: IconApps,
  pr: IconGitPullRequest,
  deploy: IconRocket,
  task: IconListCheck,
  alert: IconAlertTriangle,
  shield: IconShield,
  chart: IconActivity,
  clock: IconClock,
  database: IconDatabase,
  bug: IconBug,
  message: IconMessage,
  package: IconPackage,
  money: IconCoin,
};

/** The card's icon, shown in place of the source tile. */
export function CardIconTile({ name }: { name: CardIconName }) {
  const Glyph = ICONS[name];
  return (
    <span className={classes.iconTile} aria-hidden>
      <Glyph size={15} stroke={2.2} />
    </span>
  );
}

// ------------------------------------------------------------------ flow

/** Inline content: text and inline marks. */
function isInline(child: ContentChild): boolean {
  if (typeof child === 'string') return true;
  const placement = componentSpec(child.type)?.placement;
  return placement === 'inline';
}

/**
 * Block children, with any loose inline content (a `flow` model, or a
 * sender's mistake) gathered into paragraphs.
 */
function Blocks({ nodes }: { nodes: readonly ContentChild[] }) {
  const groups: (ContentNode | ContentChild[])[] = [];
  for (const child of nodes) {
    const last = groups.at(-1);
    if (isInline(child)) {
      if (Array.isArray(last)) last.push(child);
      else groups.push([child]);
    } else {
      groups.push(child as ContentNode);
    }
  }
  return groups.map((group, index) =>
    Array.isArray(group) ? (
      <p key={index} className={classes.text}>
        <Inline nodes={group} />
      </p>
    ) : (
      <Block key={index} node={group} />
    ),
  );
}

/**
 * Content of a flow container (a list item, quote or callout): its only
 * paragraph in the container's own type, or paragraphs among blocks.
 */
function Flow({ nodes }: { nodes: readonly ContentChild[] }) {
  if (nodes.every(isInline)) {
    return (
      <p className={classes.flowText}>
        <Inline nodes={nodes} />
      </p>
    );
  }
  return <Blocks nodes={nodes} />;
}

function Inline({ nodes }: { nodes: readonly ContentChild[] }) {
  return nodes.map((child, index) =>
    typeof child === 'string' ? child : <InlineNode key={index} node={child} />,
  );
}

const TONES = new Set([
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'working',
]);

/** A prop limited to a set of values, or its default. */
function choice<T extends string>(
  node: ContentNode,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = propString(node, name);
  return value && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function tone(node: ContentNode, name = 'tone'): string {
  const value = propString(node, name);
  return value && TONES.has(value) ? value : 'neutral';
}

const SPACING = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

function InlineNode({ node }: { node: ContentNode }) {
  const children = nodeChildren(node);
  switch (node.type) {
    case 'b':
      return (
        <b className={classes.strong}>
          <Inline nodes={children} />
        </b>
      );
    case 'i':
      return (
        <i>
          <Inline nodes={children} />
        </i>
      );
    case 's':
      return (
        <s>
          <Inline nodes={children} />
        </s>
      );
    case 'code':
      return <code className={classes.inlineCode}>{inlineText(children)}</code>;
    case 'br':
      return <br />;
    case 'a':
      return (
        <ContentLink href={propString(node, 'href')}>
          <Inline nodes={children} />
        </ContentLink>
      );
    case 'time':
      return (
        <ContentTime
          iso={propString(node, 'datetime')}
          format={choice(node, 'format', TIME_FORMATS, 'datetime')}
        />
      );
    case 'Badge':
      return <Badge node={node} />;
    case 'Icon':
      return <ContentIcon node={node} />;
    default:
      return children.length > 0 ? <Inline nodes={children} /> : null;
  }
}

function ContentLink({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  const target = href ? notificationLinkTarget(href) : null;
  if (!target) return <span>{children}</span>;
  return (
    <a {...target} className={classes.link}>
      {children}
    </a>
  );
}

const TIME_FORMATS = ['datetime', 'date', 'time'] as const;

/**
 * A time in the reader's language and time zone: the time alone today,
 * otherwise with its date (and year, when not this year).
 */
export function formatContentTime(
  iso: string,
  locale: Locale,
  format: 'datetime' | 'date' | 'time' = 'datetime',
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const today = date.toDateString() === now.toDateString();
  const thisYear = date.getFullYear() === now.getFullYear();
  const time: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };
  const day: Intl.DateTimeFormatOptions = thisYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  const options =
    format === 'time' || (format === 'datetime' && today)
      ? time
      : format === 'date'
        ? day
        : { ...day, ...time };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function ContentTime({
  iso,
  format = 'datetime',
}: {
  iso: string | undefined;
  format?: 'datetime' | 'date' | 'time';
}) {
  const { locale } = useI18n();
  if (!iso) return null;
  const text = formatContentTime(iso, locale, format);
  if (!text) return <span>{iso}</span>;
  return (
    <Tooltip label={formatExact(iso)} withArrow>
      <time dateTime={iso} className={classes.time}>
        {text}
      </time>
    </Tooltip>
  );
}

function Badge({ node }: { node: ContentNode }) {
  return (
    <span className={classes.badge} data-tone={tone(node)}>
      {inlineText(nodeChildren(node))}
    </span>
  );
}

function ContentIcon({ node }: { node: ContentNode }) {
  const name = propString(node, 'name');
  if (!name || !Object.hasOwn(ICONS, name)) return null;
  // Decorative: the text around it says what it means.
  const Glyph = ICONS[name as CardIconName];
  return (
    <Glyph
      className={classes.icon}
      data-tone={tone(node)}
      size="1.15em"
      stroke={2}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------- blocks

/** Whether a Row holds buttons, which then stack on a narrow card. */
function holdsButtons(node: ContentNode): boolean {
  return nodeChildren(node).some(
    (child) =>
      isNode(child) &&
      (child.type === 'Buttons' ||
        child.type === 'Button' ||
        child.type === 'Submit' ||
        holdsButtons(child)),
  );
}

function Block({ node }: { node: ContentNode }) {
  const children = nodeChildren(node);
  switch (node.type) {
    case 'Column':
      return (
        <div
          className={classes.column}
          data-gap={choice(node, 'gap', SPACING, 'sm')}
          data-align={propString(node, 'align')}
        >
          <Blocks nodes={children} />
        </div>
      );
    case 'Row':
      return (
        <div
          className={classes.row}
          data-gap={choice(node, 'gap', SPACING, 'sm')}
          data-justify={propString(node, 'justify')}
          data-align={propString(node, 'align')}
          data-wrap={propBool(node, 'wrap') || undefined}
          data-stack={holdsButtons(node) || undefined}
        >
          <Blocks nodes={children} />
        </div>
      );
    case 'Grid': {
      const columns = Math.min(
        4,
        Math.max(2, Math.round(propNumber(node, 'columns') ?? 2)),
      );
      return (
        <div
          className={classes.grid}
          data-gap={choice(node, 'gap', SPACING, 'sm')}
          data-columns={columns}
          style={{ '--grid-columns': columns } as CSSProperties}
        >
          <Blocks nodes={children} />
        </div>
      );
    }
    case 'Box':
      return (
        <div
          className={classes.box}
          data-surface={choice(node, 'surface', ['muted', 'outline'], 'muted')}
          data-padding={choice(node, 'padding', ['sm', 'md', 'lg'], 'md')}
          data-tone={propString(node, 'tone') ? tone(node) : undefined}
        >
          <Blocks nodes={children} />
        </div>
      );
    case 'Divider':
      return <hr className={classes.divider} />;
    case 'Spacer':
      return (
        <div
          className={classes.spacer}
          data-size={choice(node, 'size', SPACING, 'md')}
          aria-hidden
        />
      );
    case 'Collapse':
      return <Collapse node={node} />;
    case 'Title':
      return (
        <h3
          className={classes.title}
          data-size={choice(node, 'size', ['sm', 'md', 'lg', 'xl'], 'md')}
          data-align={propString(node, 'align')}
          style={clamp(node)}
        >
          <Inline nodes={children} />
        </h3>
      );
    case 'Text':
      return (
        <p
          className={classes.text}
          data-size={choice(node, 'size', SPACING, 'md')}
          data-weight={propString(node, 'weight')}
          data-ink={propString(node, 'tone')}
          data-align={propString(node, 'align')}
          data-mono={propBool(node, 'mono') || undefined}
          style={clamp(node)}
        >
          <Inline nodes={children} />
        </p>
      );
    case 'Caption':
      return (
        <p
          className={classes.caption}
          data-ink={propString(node, 'tone') ?? 'dimmed'}
          data-align={propString(node, 'align')}
          style={clamp(node)}
        >
          <Inline nodes={children} />
        </p>
      );
    case 'Markdown':
      return (
        <div className={classes.document}>
          <Blocks nodes={children} />
        </div>
      );
    case 'Badge':
      return (
        <div className={classes.blockMarker}>
          <Badge node={node} />
        </div>
      );
    case 'Icon':
      return (
        <div className={classes.blockMarker}>
          <ContentIcon node={node} />
        </div>
      );
    case 'Progress':
      return <Progress node={node} />;
    case 'Stat':
      return <Stat node={node} />;
    case 'Fields':
      return (
        <dl className={classes.fields}>
          {children.filter(isNode).map((field, index) =>
            field.type === 'Field' ? (
              <div key={index} className={classes.field}>
                <dt className={classes.fieldLabel}>
                  {propString(field, 'label')}
                </dt>
                <dd
                  className={classes.fieldValue}
                  data-mono={
                    propBool(node, 'mono') ||
                    propBool(field, 'mono') ||
                    undefined
                  }
                >
                  <Inline nodes={nodeChildren(field)} />
                </dd>
              </div>
            ) : null,
          )}
        </dl>
      );
    case 'Steps':
      return (
        <ul
          className={classes.steps}
          data-mono={propBool(node, 'mono') || undefined}
        >
          {children
            .filter(isNode)
            .map((step, index) =>
              step.type === 'Step' ? <Step key={index} node={step} /> : null,
            )}
        </ul>
      );
    case 'List':
      return <List node={node} />;
    case 'Table':
      return <Table node={node} />;
    case 'Quote':
      return <Quote node={node} />;
    case 'Code':
      return <Code node={node} />;
    case 'Trend':
      return <Trend node={node} />;
    case 'Callout':
      return (
        <div className={classes.callout} data-tone={tone(node)}>
          {propString(node, 'title') ? (
            <span className={classes.calloutTitle}>
              {propString(node, 'title')}
            </span>
          ) : null}
          <div className={classes.calloutBody}>
            <Flow nodes={children} />
          </div>
        </div>
      );
    case 'Choice':
      return <ChoiceInput node={node} />;
    case 'Buttons':
      return <ButtonsInput node={node} />;
    case 'Button':
      // An answer button belongs in Buttons; alone it can only be a link.
      return propString(node, 'href') ? <LinkButton node={node} /> : null;
    case 'Input':
      return <TextAnswerInput node={node} />;
    case 'Submit':
      return <SubmitInput node={node} />;
    default:
      if (children.length === 0) return null;
      return isInline(node) ? (
        <p className={classes.text}>
          <InlineNode node={node} />
        </p>
      ) : (
        <Blocks nodes={children} />
      );
  }
}

function clamp(node: ContentNode): CSSProperties | undefined {
  const lines = propNumber(node, 'lines');
  return lines ? ({ '--lines': lines } as CSSProperties) : undefined;
}

function Collapse({ node }: { node: ContentNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={classes.collapse}>
      <button
        type="button"
        className={classes.collapseToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconChevronRight
          size={13}
          stroke={2.4}
          className={classes.chevron}
          data-open={open || undefined}
          aria-hidden
        />
        {propString(node, 'summary')}
      </button>
      {open ? (
        <div className={classes.collapseBody}>
          <Blocks nodes={nodeChildren(node)} />
        </div>
      ) : null}
    </div>
  );
}

function Progress({ node }: { node: ContentNode }) {
  const label = propString(node, 'label');
  const value = propString(node, 'value');
  const percent = Math.min(100, Math.max(0, propNumber(node, 'percent') ?? 0));
  return (
    <div className={classes.progress}>
      {label || value ? (
        <div className={classes.progressHead}>
          <span>{label}</span>
          {value ? (
            <span className={classes.progressValue}>{value}</span>
          ) : null}
        </div>
      ) : null}
      <progress
        className={classes.progressTrack}
        aria-label={label}
        aria-valuetext={value}
        value={percent}
        max={100}
        data-tone={tone(node)}
      />
    </div>
  );
}

function Stat({ node }: { node: ContentNode }) {
  const delta = propString(node, 'delta');
  return (
    <div className={classes.stat}>
      <span className={classes.statLabel}>{propString(node, 'label')}</span>
      <span className={classes.statValue}>{propString(node, 'value')}</span>
      {delta ? (
        <span className={classes.statDelta} data-ink={tone(node)}>
          {delta}
        </span>
      ) : null}
    </div>
  );
}

const STEP_STATES = [
  'done',
  'failed',
  'running',
  'pending',
  'skipped',
] as const;
type StepState = (typeof STEP_STATES)[number];

const STEP_ICONS: Record<StepState, Icon> = {
  done: IconCheck,
  failed: IconX,
  running: IconLoader2,
  pending: IconCircle,
  skipped: IconMinus,
};

const STEP_LABELS = {
  done: 'notifications.content.step.done',
  failed: 'notifications.content.step.failed',
  running: 'notifications.content.step.running',
  pending: 'notifications.content.step.pending',
  skipped: 'notifications.content.step.skipped',
} as const satisfies Record<StepState, PlainTranslationKey>;

function Step({ node }: { node: ContentNode }) {
  const { t } = useI18n();
  const state = choice(node, 'state', STEP_STATES, 'pending');
  const Glyph = STEP_ICONS[state];
  const detail = propString(node, 'detail');
  const at = propString(node, 'at');
  const href = propString(node, 'href');
  const name = <Inline nodes={nodeChildren(node)} />;
  return (
    <li className={classes.step} data-state={state}>
      <Glyph
        className={classes.stepIcon}
        size={14}
        stroke={state === 'pending' ? 2.2 : 2.6}
        aria-hidden
      />
      <VisuallyHidden>{t(STEP_LABELS[state])}</VisuallyHidden>
      <span className={classes.stepName}>
        {href ? <ContentLink href={href}>{name}</ContentLink> : name}
      </span>
      {detail || at ? (
        <span className={classes.stepDetail}>
          {detail ?? <ContentTime iso={at} />}
        </span>
      ) : null}
    </li>
  );
}

function List({ node }: { node: ContentNode }) {
  const ordered = propBool(node, 'ordered');
  const items = nodeChildren(node)
    .filter(isNode)
    .filter((item) => item.type === 'Item');
  const task = items.some((item) => typeof item.props?.checked === 'boolean');
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={classes.list} data-task={task || undefined}>
      {items.map((item, index) => {
        const checked = item.props?.checked;
        return (
          <li key={index} className={classes.item}>
            {typeof checked === 'boolean' ? (
              <Checkbox
                className={classes.taskBox}
                size="xs"
                checked={checked}
                readOnly
                tabIndex={-1}
                aria-label={inlineText(nodeChildren(item))}
              />
            ) : null}
            <div className={classes.itemBody}>
              <Flow nodes={nodeChildren(item)} />
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function Table({ node }: { node: ContentNode }) {
  const rows = nodeChildren(node)
    .filter(isNode)
    .filter((row) => row.type === 'Tr');
  // Leading rows of header cells only form the head.
  let headRows = 0;
  while (
    headRows < rows.length - 1 &&
    nodeChildren(rows[headRows]!).every(
      (cell) => isNode(cell) && cell.type === 'Th',
    )
  ) {
    headRows += 1;
  }
  const row = (tr: ContentNode, index: number) => (
    <tr key={index}>
      {nodeChildren(tr)
        .filter(isNode)
        .map((cell, cellIndex) => {
          const Cell = cell.type === 'Th' ? 'th' : 'td';
          if (cell.type !== 'Th' && cell.type !== 'Td') return null;
          return (
            <Cell
              key={cellIndex}
              className={classes.cell}
              data-align={propString(cell, 'align')}
            >
              <Inline nodes={nodeChildren(cell)} />
            </Cell>
          );
        })}
    </tr>
  );
  return (
    <div className={classes.tableWrap}>
      <table className={classes.table}>
        {headRows > 0 ? (
          <thead>{rows.slice(0, headRows).map(row)}</thead>
        ) : null}
        <tbody>
          {rows.slice(headRows).map((tr, index) => row(tr, index + headRows))}
        </tbody>
      </table>
    </div>
  );
}

function Quote({ node }: { node: ContentNode }) {
  const author = propString(node, 'author');
  const location = propString(node, 'location');
  return (
    <blockquote className={classes.quote}>
      {author || location ? (
        <span className={classes.quoteMeta}>
          {author ? <b className={classes.strong}>{author}</b> : null}
          {author && location ? ' · ' : null}
          {location}
        </span>
      ) : null}
      <div className={classes.quoteText}>
        <Flow nodes={nodeChildren(node)} />
      </div>
    </blockquote>
  );
}

function Code({ node }: { node: ContentNode }) {
  const text = inlineText(nodeChildren(node));
  const diff = propString(node, 'language') === 'diff';
  return (
    <pre className={classes.code}>
      {diff
        ? text.split('\n').map((line, index) => (
            <span
              key={index}
              className={classes.diffLine}
              data-change={
                line.startsWith('+')
                  ? 'add'
                  : line.startsWith('-')
                    ? 'remove'
                    : undefined
              }
            >
              {line || ' '}
            </span>
          ))
        : text}
    </pre>
  );
}

function Trend({ node }: { node: ContentNode }) {
  const { t } = useI18n();
  const raw = node.props?.values;
  const values = (
    Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(',').map(Number)
        : []
  ).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  const threshold = propNumber(node, 'threshold');
  const unit = propString(node, 'unit') ?? '';
  const label = propString(node, 'label');
  const top = Math.max(...values, threshold ?? Number.NEGATIVE_INFINITY, 0);
  const height = (value: number) =>
    top > 0 ? `${Math.max(2, (Math.max(0, value) / top) * 100)}%` : '2px';
  const description = t('notifications.content.trend', {
    label: label ?? t('notifications.content.trendDefault'),
    values: values.map((value) => `${unit}${value}`).join(', '),
  });
  return (
    <div className={classes.trend}>
      {label ? <span className={classes.trendLabel}>{label}</span> : null}
      <VisuallyHidden>{description}</VisuallyHidden>
      <div className={classes.trendBars} aria-hidden>
        {threshold !== undefined && top > 0 ? (
          <span
            className={classes.trendThreshold}
            style={{ bottom: `${(Math.max(0, threshold) / top) * 100}%` }}
          />
        ) : null}
        {values.map((value, index) => (
          <span
            key={index}
            className={classes.trendBar}
            data-over={
              (threshold !== undefined && value > threshold) || undefined
            }
            style={{ height: height(value) }}
          />
        ))}
      </div>
    </div>
  );
}
