import { ActionIcon, Menu, UnstyledButton } from '@mantine/core';
import { IconDots, IconPlus } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import classes from './dock.module.css';

/**
 * What the shell tells the dock about open windows. The dock marks every item
 * listed here and keeps no notion of "the current App" itself.
 */
export type DockOpenItem =
  | {
      kind: 'app';
      slug: string;
      /** Route inside the App, as the URL fragment without `#`. */
      route: string;
    }
  | { kind: 'workflow'; slug: string };

/**
 * One dock tile: the link with its label and open marker, and, when it has
 * actions, an options menu beside it so the menu never triggers the link.
 * `menuKey` lets the dock's right-click menu tell which tile was clicked.
 */
export function DockItem({
  label,
  open,
  shape = 'app',
  glyph,
  renderLink,
  menuKey,
  menu,
}: {
  label: string;
  /** Whether this item's window is open. */
  open: boolean;
  shape?: 'app' | 'workflow';
  glyph: ReactNode;
  /** Renders the link; receives the props the dock needs on it. */
  renderLink: (props: {
    className: string;
    title: string;
    draggable: false;
    /**
     * The open marker. Not `aria-current`: the router sets that on every link
     * to the current page, which would mark both pins of one App.
     */
    'data-open': 'true' | undefined;
    children: ReactNode;
  }) => ReactNode;
  menuKey?: string;
  /** The tile's own actions: `Menu.Item`s. */
  menu?: ReactNode;
}) {
  return (
    <div className={classes.slot} data-dock-key={menuKey}>
      {renderLink({
        className: classes.item,
        title: label,
        draggable: false,
        'data-open': open ? 'true' : undefined,
        children: (
          <>
            <span className={classes.tile} data-shape={shape}>
              {glyph}
            </span>
            <span className={classes.label}>{label}</span>
            <span className={classes.marker} aria-hidden />
          </>
        ),
      })}
      {menu ? (
        <Menu position="top" shadow="md" width={170}>
          <Menu.Target>
            <ActionIcon
              className={classes.options}
              variant="default"
              size={20}
              radius="xl"
              aria-label={`${label} options`}
            >
              <IconDots size={13} stroke={2} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>{menu}</Menu.Dropdown>
        </Menu>
      ) : null}
    </div>
  );
}

/**
 * The dashed tile of an empty Apps group, labelled like any other tile;
 * opens the App picker.
 */
export function DockAddButton({
  label,
  children,
}: {
  label: string;
  /** The picker: `Menu.Item`s and `Menu.Label`s. */
  children: ReactNode;
}) {
  return (
    <Menu position="top" shadow="md" width={240}>
      <Menu.Target>
        <UnstyledButton className={classes.item}>
          <span className={classes.add}>
            <IconPlus size={16} stroke={2.4} aria-hidden />
          </span>
          <span className={classes.label}>{label}</span>
          <span className={classes.marker} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}

/** The glyph of the All apps tile: four dots in the dock tile's square. */
export function AllAppsGlyph() {
  return (
    <span className={classes.allApps} aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
