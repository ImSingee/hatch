import { Box, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { DeskWindow, type DeskWindowProps } from './window';
import classes from './window-page.module.css';

type WindowPageProps = Pick<
  DeskWindowProps,
  'title' | 'tile' | 'badge' | 'closeTo' | 'fill'
> & {
  description?: ReactNode;
  actions?: ReactNode;
  /** Constrain content width for readability. Defaults to a wide column. */
  size?: number;
  children: ReactNode;
};

/** Gutter the window adds around the content column, both sides together. */
const GUTTER = 96;

/**
 * A page inside a window: the title goes to the title bar, and the body is a
 * scrolling column that starts with the page's description and actions.
 */
export function WindowPage({
  description,
  actions,
  size = 1180,
  children,
  ...window
}: WindowPageProps) {
  return (
    <DeskWindow {...window} maxWidth={size + GUTTER}>
      <Box className={classes.scroll}>
        {description || actions ? (
          <Group
            justify="space-between"
            align="center"
            wrap="wrap"
            gap="md"
            className={classes.header}
          >
            {description ? (
              <Text c="dimmed" size="sm" className={classes.description}>
                {description}
              </Text>
            ) : (
              <span />
            )}
            {actions ? (
              <Group gap="xs" wrap="wrap" className={classes.actions}>
                {actions}
              </Group>
            ) : null}
          </Group>
        ) : null}
        <Box className={classes.body}>{children}</Box>
      </Box>
    </DeskWindow>
  );
}
