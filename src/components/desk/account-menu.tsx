import { Avatar, Menu, Text, UnstyledButton } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconBell,
  IconLayoutDashboard,
  IconLogout,
  IconSettings,
} from '@tabler/icons-react';
import { authClient } from '~auth/client';
import { useSignOut } from '~auth/use-sign-out';
import classes from './menu-bar.module.css';

/** The account tile at the end of the menu bar and the pages behind it. */
export function AccountMenu() {
  const { signOut, leaving } = useSignOut();
  const { data } = authClient.useSession();
  const email = data?.user.email ?? 'account';
  const name = data?.user.name || email;

  return (
    <Menu position="bottom-end" width={220} shadow="md">
      <Menu.Target>
        <UnstyledButton className={classes.account} aria-label="Account menu">
          <Avatar
            size={26}
            radius="sm"
            name={name}
            color="primary"
            variant="filled"
          />
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="xs" truncate>
            {email}
          </Text>
        </Menu.Label>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconBell size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/notifications" {...props} />}
        >
          Notifications
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Dashboards
        </Menu.Item>
        <Menu.Item
          leftSection={<IconSettings size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings" {...props} />}
        >
          Settings
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
          disabled={leaving}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
