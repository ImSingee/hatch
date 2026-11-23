import { TextInput, ThemeIcon } from '@mantine/core';
import { Link, type LinkProps } from '@tanstack/react-router';
import { IconSearch } from '@tabler/icons-react';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import classes from './split.module.css';

export type RailItem = {
  key: string;
  label: string;
  /** The 14 px icon shown in the item's coloured tile. */
  icon: ReactNode;
  /** Mantine colour name of the tile. Defaults to the accent. */
  color?: string;
  link: LinkProps;
  /** Marks the current section. */
  current: boolean;
  /** Extra words the rail search matches, beyond the label. */
  keywords?: string;
};

export type RailGroup = {
  label?: string;
  items: RailItem[];
};

/**
 * A window body split into a section rail and the current section. Below
 * 800 px wide the rail lies down above the section and scrolls sideways.
 */
export function WindowSplit({
  rail,
  railWidth,
  children,
}: {
  rail: ReactNode;
  railWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      className={classes.split}
      style={
        railWidth
          ? ({ '--rail-width': `${railWidth}px` } as CSSProperties)
          : undefined
      }
    >
      {rail}
      <div className={classes.main}>{children}</div>
    </div>
  );
}

/** What the rail is about: a tile, a name and one line under it. */
export function RailIdentity({
  tile,
  monogram,
  name,
  meta,
}: {
  /** A ready 48 px tile, such as an App glyph. */
  tile?: ReactNode;
  /** A letter on the accent, when there is no tile. */
  monogram?: string;
  name: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className={classes.identity}>
      <span
        className={classes.identityTile}
        data-monogram={tile ? undefined : true}
        aria-hidden
      >
        {tile ?? monogram}
      </span>
      <div className={classes.identityText}>
        <span className={classes.identityName}>{name}</span>
        {meta ? <span className={classes.identityMeta}>{meta}</span> : null}
      </div>
    </div>
  );
}

/**
 * The section rail of a split window: an identity, a filter over the
 * sections, the sections, and actions pinned to the bottom.
 */
export function Rail({
  label,
  identity,
  groups,
  searchLabel,
  footer,
}: {
  /** Accessible name of the navigation. */
  label: string;
  identity?: ReactNode;
  groups: RailGroup[];
  /** Shows a filter field with this placeholder. */
  searchLabel?: string;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          !needle ||
          `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.items.length > 0);

  // On a narrow window the links scroll sideways: keep the current one in
  // view when the section changes.
  const nav = useRef<HTMLElement>(null);
  const currentKey = groups
    .flatMap((group) => group.items)
    .find((item) => item.current)?.key;
  useEffect(() => {
    nav.current
      ?.querySelector('[data-current]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentKey]);

  return (
    <aside className={classes.rail}>
      {identity}
      {searchLabel ? (
        <TextInput
          className={classes.search}
          type="search"
          size="sm"
          aria-label={searchLabel}
          placeholder={searchLabel}
          leftSection={<IconSearch size={15} stroke={2} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      ) : null}
      <nav ref={nav} aria-label={label} className={classes.nav}>
        {visible.length === 0 ? (
          <p className={classes.none}>Nothing matches “{query.trim()}”.</p>
        ) : null}
        {visible.map((group) => (
          <Fragment key={group.label ?? group.items[0].key}>
            {group.label ? (
              <span className={classes.label}>{group.label}</span>
            ) : null}
            {group.items.map((item) => (
              <Link
                key={item.key}
                {...item.link}
                className={classes.link}
                data-current={item.current || undefined}
                aria-current={item.current ? 'page' : undefined}
              >
                <ThemeIcon
                  size={26}
                  radius="sm"
                  color={item.color ?? 'primary'}
                  aria-hidden
                >
                  {item.icon}
                </ThemeIcon>
                {item.label}
              </Link>
            ))}
          </Fragment>
        ))}
      </nav>
      {footer ? <div className={classes.footer}>{footer}</div> : null}
    </aside>
  );
}
