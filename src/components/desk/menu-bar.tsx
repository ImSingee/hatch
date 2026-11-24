import { Menu, Text, UnstyledButton } from '@mantine/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { IconBell, IconMenu2 } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useNotificationReadState } from '~components/notifications/use-notification-read-state';
import { useI18n } from '~/i18n';
import { AccountMenu } from './account-menu';
import { Brand } from './brand';
import { CommandPalette } from './command-palette';
import { RunnerStatus } from './runner-status';
import { DESK_HOME } from './paths';
import classes from './menu-bar.module.css';

const NAV = [
  { to: DESK_HOME, label: 'Desk' },
  { to: '/agent', label: 'Agent' },
  { to: '/apps', label: 'All apps' },
] as const;

function isUnder(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The bar across the top of the desk: brand, primary navigation, a warning
 * when no Agent Runner is connected, search, notifications, date and the
 * account. Below 768 wide the navigation folds into a menu and the bar shows
 * which section is open instead; the runner warning keeps only its dot.
 */
export function MenuBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = NAV.find((item) => isUnder(pathname, item.to));

  return (
    <header className={classes.bar}>
      <div className={classes.side}>
        <Menu position="bottom-start" width={200} shadow="md">
          <Menu.Target>
            <UnstyledButton
              className={`${classes.item} ${classes.fold}`}
              aria-label="Open navigation"
            >
              <IconMenu2 size={20} stroke={2} aria-hidden />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown>
            {NAV.map((item) => (
              <Menu.Item
                key={item.to}
                renderRoot={(props) => <Link to={item.to} {...props} />}
              >
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>

        <Link
          to={DESK_HOME}
          className={`${classes.item} ${classes.brand}`}
          aria-label="Hatch, back to the desk"
        >
          <Brand size="xs" />
        </Link>

        <span aria-hidden className={classes.divider} />

        <nav aria-label="Primary" className={classes.nav}>
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={classes.item}
              aria-current={current === item ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {current ? (
          <Text component="span" className={classes.section}>
            {current.label}
          </Text>
        ) : null}
      </div>

      <div className={classes.side}>
        <RunnerStatus />
        <CommandPalette />
        <NotificationsLink current={isUnder(pathname, '/notifications')} />
        <Text component="span" className={classes.date}>
          {dayjs().format('ddd, MMM D')}
        </Text>
        <AccountMenu />
      </div>
    </header>
  );
}

/** The bell, with a dot while anything is unread. */
function NotificationsLink({ current }: { current: boolean }) {
  const { t } = useI18n();
  const unread = useNotificationReadState().data?.unreadCount ?? 0;
  return (
    <Link
      to="/notifications"
      className={`${classes.item} ${classes.icon} ${classes.bell}`}
      aria-label={
        unread > 0
          ? t('nav.notificationsUnread', { count: unread })
          : t('nav.notifications')
      }
      aria-current={current ? 'page' : undefined}
    >
      <IconBell size={18} stroke={1.8} aria-hidden />
      {unread > 0 ? <span className={classes.unreadDot} aria-hidden /> : null}
    </Link>
  );
}
