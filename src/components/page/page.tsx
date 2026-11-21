import { Table, type TableProps, TextInput } from '@mantine/core';
import { Link, type LinkProps } from '@tanstack/react-router';
import { IconChevronRight, IconSearch } from '@tabler/icons-react';
import {
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
  useId,
} from 'react';
import classes from './page.module.css';

/**
 * The scrolling body of a window. `ground` is the pale sheet that grouped
 * cards sit on; `sheet` is the plain white of the window itself.
 */
export function WindowBody({
  tone = 'ground',
  size,
  children,
}: {
  tone?: 'ground' | 'sheet';
  /** Widest the content column grows, in px. */
  size?: number;
  children: ReactNode;
}) {
  return (
    <div className={classes.body} data-tone={tone}>
      <div
        className={classes.bodyInner}
        style={
          size ? ({ '--body-max-width': `${size}px` } as CSSProperties) : {}
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The headline of a window body. The window's title bar already names the
 * page, so a body uses this only where the canvas draws a headline: a
 * section of a split window, or a list page with a count and actions.
 */
export function PageHeading({
  title,
  meta,
  description,
  actions,
}: {
  /** Leave out when the window title already names the page. */
  title?: ReactNode;
  /** A short fact next to the title, such as a count. */
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={classes.heading}>
      <div className={classes.headingText}>
        <div className={classes.headingTitleRow}>
          {title ? <h2 className={classes.headingTitle}>{title}</h2> : null}
          {meta ? <span className={classes.headingMeta}>{meta}</span> : null}
        </div>
        {description ? (
          <p className={classes.headingDescription}>{description}</p>
        ) : null}
      </div>
      {actions ? <div className={classes.headingActions}>{actions}</div> : null}
    </div>
  );
}

/** A group label above grouped content, with an optional meta and actions. */
export function Section({
  title,
  meta,
  aside,
  note,
  id,
  children,
}: {
  title: ReactNode;
  /** A short fact after the title, such as "3 versions". */
  meta?: ReactNode;
  /** Controls at the end of the heading row. */
  aside?: ReactNode;
  /** One muted line under the content. */
  note?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={classes.section}>
      <div className={classes.sectionHead}>
        <div className={classes.sectionTitleRow}>
          <h3 id={headingId} className={classes.eyebrow}>
            {title}
          </h3>
          {meta ? <span className={classes.sectionMeta}>{meta}</span> : null}
        </div>
        {aside ? <div className={classes.sectionAside}>{aside}</div> : null}
      </div>
      {children}
      {note ? <p className={classes.sectionNote}>{note}</p> : null}
    </section>
  );
}

/** Columns that sit side by side when there is room and stack when not. */
export function Columns({ children }: { children: ReactNode }) {
  return <div className={classes.columns}>{children}</div>;
}

export function Column({
  basis = 400,
  grow,
  children,
}: {
  /** Narrowest the column gets before the columns stack, in px. */
  basis?: number;
  /** Take the room the other columns leave. */
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={classes.column}
      style={
        {
          '--column-basis': `${basis}px`,
          flexGrow: grow ? 999 : undefined,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}

type GroupProps<T extends ElementType> = {
  component?: T;
  /** Pad the content; leave off for rows, items and tables. */
  padded?: boolean;
  /** A dashed outline for something that is not set up yet. */
  dashed?: boolean;
} & Omit<ComponentPropsWithoutRef<T>, 'className'>;

/** Grouped content inside a window: hairline outline, flat, radius 16. */
export function GroupCard<T extends ElementType = 'div'>({
  component,
  padded,
  dashed,
  ...rest
}: GroupProps<T>) {
  const Component: ElementType = component ?? 'div';
  return (
    <Component
      className={classes.group}
      data-padded={padded || undefined}
      data-dashed={dashed || undefined}
      {...rest}
    />
  );
}

/** A padded block inside a group card, for a form or free content. */
export function GroupBlock({ children }: { children: ReactNode }) {
  return <div className={classes.groupBlock}>{children}</div>;
}

/** The muted strip that closes a group card. */
export function GroupFooter({ children }: { children: ReactNode }) {
  return <div className={classes.groupFooter}>{children}</div>;
}

/** One label and its value. `stack` puts a long value under the label. */
export function Row({
  label,
  mono,
  stack,
  children,
}: {
  label?: ReactNode;
  mono?: boolean;
  stack?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={classes.row} data-stack={stack || undefined}>
      {label ? <span className={classes.rowLabel}>{label}</span> : null}
      <span className={classes.rowValue} data-mono={mono || undefined}>
        {children}
      </span>
    </div>
  );
}

/** A row that leads somewhere, with a chevron at its end. */
export function RowLink({
  children,
  ...link
}: LinkProps & { children: ReactNode }) {
  return (
    <Link {...link} className={classes.row}>
      <span>{children}</span>
      <IconChevronRight
        size={16}
        stroke={2}
        className={classes.rowChevron}
        aria-hidden
      />
    </Link>
  );
}

/** The neutral tile that leads a list row. */
export function LeadTile({ children }: { children: ReactNode }) {
  return (
    <span className={classes.leadTile} aria-hidden>
      {children}
    </span>
  );
}

/** A list row: a leading tile, a title, one meta line and trailing actions. */
export function Item({
  component = 'div',
  lead,
  title,
  meta,
  trailing,
  wrap,
  children,
}: {
  component?: 'div' | 'li';
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Let the trailing actions drop under the text on a narrow window. */
  wrap?: boolean;
  children?: ReactNode;
}) {
  const Component = component;
  return (
    <Component className={classes.item} data-wrap={wrap || undefined}>
      {lead}
      <div className={classes.itemText}>
        <span className={classes.itemTitle}>{title}</span>
        {meta ? <span className={classes.itemMeta}>{meta}</span> : null}
        {children}
      </div>
      {trailing ? <div className={classes.itemTrailing}>{trailing}</div> : null}
    </Component>
  );
}

/**
 * A table inside a group card. It scrolls sideways when the window is
 * narrower than its columns, so no column is squeezed or dropped.
 */
export function TableCard({
  children,
  footer,
  ...table
}: TableProps & { footer?: ReactNode }) {
  return (
    <GroupCard>
      <div className={classes.tableScroll}>
        <Table verticalSpacing={0} highlightOnHover {...table}>
          {children}
        </Table>
      </div>
      {footer ? <GroupFooter>{footer}</GroupFooter> : null}
    </GroupCard>
  );
}

/**
 * Nothing here yet. `page` fills the body of a window; `dashed` sits in
 * place of a group's content.
 */
export function EmptyState({
  icon,
  tone = 'neutral',
  variant = 'page',
  title,
  children,
  actions,
}: {
  icon?: ReactNode;
  tone?: 'neutral' | 'accent' | 'danger';
  variant?: 'page' | 'dashed';
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={classes.empty} data-variant={variant}>
      {icon ? (
        <span className={classes.emptyTile} data-tone={tone} aria-hidden>
          {icon}
        </span>
      ) : null}
      <p className={classes.emptyTitle}>{title}</p>
      {children ? <p className={classes.emptyText}>{children}</p> : null}
      {actions ? <div className={classes.emptyActions}>{actions}</div> : null}
    </div>
  );
}

/** The one muted line that stands in for the rows of an empty list. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className={classes.emptyLine}>{children}</p>;
}

/** A dashed note that explains where a change is made instead. */
export function Callout({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={classes.callout}>
      <span className={classes.calloutTitle}>{title}</span>
      {children}
    </div>
  );
}

/** Code, identifiers and values a user may copy. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className={classes.mono}>{children}</span>;
}

/**
 * The controls above a list. `lead` says what the list holds (a count); the
 * children are filters and actions. It wraps onto more lines when narrow.
 */
export function Toolbar({
  lead,
  children,
}: {
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={classes.toolbar}>
      {lead ? <span className={classes.toolbarLead}>{lead}</span> : null}
      {children}
    </div>
  );
}

/** The search field of a toolbar. */
export function ToolbarSearch({
  label,
  value,
  onChange,
}: {
  /** Accessible name and placeholder. */
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TextInput
      className={classes.toolbarSearch}
      type="search"
      size="md"
      aria-label={label}
      placeholder={label}
      leftSection={<IconSearch size={16} stroke={2} />}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
