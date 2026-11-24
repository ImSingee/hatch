import { Menu, Text, UnstyledButton } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconBell,
  IconLayoutDashboard,
  IconLogout,
  IconSettings,
} from '@tabler/icons-react';
import { authClient } from '~auth/client';
import { UserAvatar } from '~components/auth/user-avatar';
import { useSignOut } from '~auth/use-sign-out';
import { useI18n } from '~i18n';
import classes from './menu-bar.module.css';

/** The account tile at the end of the menu bar and the pages behind it. */
export function AccountMenu() {
  const { t } = useI18n();
  const { signOut, leaving } = useSignOut();
  const { data } = authClient.useSession();
  const email = data?.user.email ?? 'account';
  const name = data?.user.name || email;

  return (
    <Menu position="bottom-end" width={220} shadow="md">
      <Menu.Target>
        <UnstyledButton
          className={classes.account}
          aria-label={t('nav.accountMenu')}
        >
          <UserAvatar
            userId={data?.user.id}
            image={data?.user.image}
            name={name}
            size={26}
            radius="sm"
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
          {t('nav.notifications')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          {t('nav.dashboards')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconSettings size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/settings" {...props} />}
        >
          {t('nav.settings')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
          disabled={leaving}
        >
          {t('common.signOut')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
