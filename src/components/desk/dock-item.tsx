import { Menu, Tooltip, UnstyledButton } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import classes from './dock.module.css';

/**
 * What the shell tells the dock about open windows. The dock marks every item
 * listed here and keeps no notion of "the current App" itself.
 */
export type DockOpenItem = {
  kind: 'app';
  slug: string;
  /** Route inside the App, as the URL fragment without `#`. */
  route: string;
};

/**
 * The full name above a tile while it is pointed at or has keyboard focus,
 * whether or not the dock prints names. Hidden while the dock's right-click
 * menu is open.
 */
function TileName({
  label,
  hidden,
  children,
}: {
  label: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip
      label={label}
      position="top"
      offset={8}
      disabled={hidden}
      // Keyboard focus shows the name too; with names hidden, it is the only
      // way to tell two shortcuts of one App apart.
      events={{ hover: true, focus: true, touch: false }}
    >
      {children}
    </Tooltip>
  );
}

/**
 * One dock tile: the link with its name and open marker. Its actions live in
 * the dock's right-click menu; `menuKey` tells that menu which tile it is.
 */
export function DockItem({
  label,
  open,
  glyph,
  renderLink,
  menuKey,
  hintHidden,
}: {
  label: string;
  /** Whether this item's window is open. */
  open: boolean;
  glyph: ReactNode;
  /** Renders the link; receives the props the dock needs on it. */
  renderLink: (props: {
    className: string;
    'aria-label': string;
    draggable: false;
    /**
     * The open marker. Not `aria-current`: the router sets that on every link
     * to the current page, which would mark both pins of one App.
     */
    'data-open': 'true' | undefined;
    children: ReactNode;
  }) => ReactNode;
  menuKey?: string;
  /** Hide the name hint, e.g. while the right-click menu is open. */
  hintHidden: boolean;
}) {
  return (
    <div className={classes.slot} data-dock-key={menuKey}>
      <TileName label={label} hidden={hintHidden}>
        {renderLink({
          className: classes.item,
          // The printed name may be hidden or cut short; this is the name.
          'aria-label': label,
          draggable: false,
          'data-open': open ? 'true' : undefined,
          children: (
            <>
              <span className={classes.tile}>{glyph}</span>
              <span className={classes.label} aria-hidden>
                {label}
              </span>
              <span className={classes.marker} aria-hidden />
            </>
          ),
        })}
      </TileName>
    </div>
  );
}

/**
 * The dashed tile of an empty Apps group, named like any other tile; opens
 * the App picker.
 */
export function DockAddButton({
  label,
  hintHidden,
  children,
}: {
  label: string;
  hintHidden: boolean;
  /** The picker: `Menu.Item`s and `Menu.Label`s. */
  children: ReactNode;
}) {
  return (
    <Menu position="top" shadow="md" width={240}>
      <TileName label={label} hidden={hintHidden}>
        <Menu.Target>
          <UnstyledButton className={classes.item} aria-label={label}>
            <span className={classes.add}>
              <IconPlus size={16} stroke={2.4} aria-hidden />
            </span>
            <span className={classes.label} aria-hidden>
              {label}
            </span>
            <span className={classes.marker} aria-hidden />
          </UnstyledButton>
        </Menu.Target>
      </TileName>
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
