import { Box, Group, Stack, Text, Title } from '@mantine/core';
import dayjs from 'dayjs';
import { type ReactNode, useEffect, useRef } from 'react';
import { DeskPins } from './desk-pins';
import classes from './desk-home.module.css';

type DeskHomeProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Widest the desk content grows, in px. */
  size?: number;
  /** Hide the heading for task-focused modes such as the layout editor. */
  hideHeader?: boolean;
  /** The desk widgets. */
  children: ReactNode;
};

/**
 * The desk with no window open: the heading and the region desk widgets sit
 * in, straight on the ground. Below 560 wide, where the dock gives way to the
 * tab bar, the pinned Apps and Workflows are listed here instead.
 */
export function DeskHome({
  title,
  description,
  actions,
  size = 1180,
  hideHeader = false,
  children,
}: DeskHomeProps) {
  const root = useRef<HTMLDivElement>(null);

  // Arriving at the desk (a window was closed) starts keyboard users here
  // rather than on a control that no longer exists.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    element.focus({ preventScroll: true });
  }, []);

  return (
    <Box
      ref={root}
      tabIndex={-1}
      className={classes.root}
      data-headerless={hideHeader || undefined}
    >
      <Box className={classes.inner} style={{ maxWidth: size }}>
        {hideHeader ? null : (
          <Group
            justify="space-between"
            align="flex-end"
            wrap="wrap"
            gap="md"
            className={classes.header}
          >
            <Stack gap={2} className={classes.titleBlock}>
              <Text className={classes.date}>
                {dayjs().format('dddd, MMMM D')}
              </Text>
              <Title order={1} className={classes.title}>
                {title}
              </Title>
              {description ? (
                <Text c="dimmed" size="sm" className={classes.description}>
                  {description}
                </Text>
              ) : null}
            </Stack>
            {actions ? (
              <Group gap="xs" wrap="wrap" className={classes.actions}>
                {actions}
              </Group>
            ) : null}
          </Group>
        )}
        {hideHeader ? null : <DeskPins />}
        <Box className={classes.widgets}>{children}</Box>
      </Box>
    </Box>
  );
}
