import { ActionIcon, Menu, UnstyledButton } from '@mantine/core';
import { IconDots, IconPinnedOff, IconPlus } from '@tabler/icons-react';
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
 * One pinned item: the tile link with its label and open marker, and an
 * options menu beside it so the menu never triggers the link.
 */
export function DockItem({
  label,
  open,
  shape = 'app',
  glyph,
  renderLink,
  onUnpin,
  menuItems,
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
  onUnpin: () => void;
  /** Menu items placed around the built-in Unpin: before and after it. */
  menuItems?: { before?: ReactNode; after?: ReactNode };
}) {
  return (
    <div className={classes.slot}>
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
        <Menu.Dropdown>
          {menuItems?.before}
          <Menu.Item
            leftSection={<IconPinnedOff size={15} stroke={1.7} />}
            onClick={onUnpin}
          >
            Unpin
          </Menu.Item>
          {menuItems?.after}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

/** The dashed tile at the end of a dock group; opens the pin picker. */
export function DockAddButton({
  label,
  shape = 'app',
  children,
}: {
  label: string;
  shape?: 'app' | 'workflow';
  /** The picker: `Menu.Item`s and `Menu.Label`s. */
  children: ReactNode;
}) {
  return (
    <Menu position="top" shadow="md" width={240}>
      <Menu.Target>
        <UnstyledButton
          className={classes.add}
          data-shape={shape}
          aria-label={label}
        >
          <IconPlus size={16} stroke={2.4} aria-hidden />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>{children}</Menu.Dropdown>
    </Menu>
  );
}
