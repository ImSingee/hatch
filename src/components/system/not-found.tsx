import { Button, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconCompassOff } from '@tabler/icons-react';
import { useInsideDeskShell } from '~components/desk/desk-context';
import { DeskStandalone } from '~components/desk/desk-standalone';
import { DeskWindow } from '~components/desk/window';

/**
 * Not found, as a window on the desk: inside the signed-in shell it takes
 * the stage like any page; on its own it brings the desk ground with it.
 */
export function NotFoundElement(_props: {}) {
  const insideShell = useInsideDeskShell();
  const window = (
    <DeskWindow title="Page not found" maxWidth={520}>
      <Stack align="center" gap="sm" px="xl" py={40}>
        <ThemeIcon size={56} radius="lg" variant="light" color="gray">
          <IconCompassOff size={26} stroke={1.6} />
        </ThemeIcon>
        <Title order={2} ta="center">
          Nothing lives at this address
        </Title>
        <Text c="dimmed" ta="center" maw={380}>
          The address may be mistyped, or the page was moved, renamed or
          deleted.
        </Text>
        <Button component={Link} to="/" mt="sm">
          Back to the desk
        </Button>
      </Stack>
    </DeskWindow>
  );
  return insideShell ? window : <DeskStandalone>{window}</DeskStandalone>;
}
