import { ThemeIcon } from '@mantine/core';
import { IconBell } from '@tabler/icons-react';

/** The Notifications windows' title bar tile. */
export function NotificationsTile() {
  return (
    <ThemeIcon size={22} radius="xs" color="amber">
      <IconBell size={13} stroke={2.4} />
    </ThemeIcon>
  );
}
