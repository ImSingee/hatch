import { Menu, Text, UnstyledButton } from '@mantine/core';
import { Link, useRouterState } from '@tanstack/react-router';
import { IconBell, IconMenu2 } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { AccountMenu } from './account-menu';
import { Brand } from './brand';
import { CommandPalette } from './command-palette';
import { RunnerStatus } from './runner-status';
import { SpaceMenu } from './space-menu';
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
 * The bar across the top of the desk: brand, space, primary navigation,
 * runner status, search, notifications, date and the account. Below 768
 * wide the navigation folds into a menu and the bar shows which section is
 * open instead; the space name and the runner's words give way to icons.
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

        <SpaceMenu />

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
        <Link
          to="/notifications"
          className={`${classes.item} ${classes.icon}`}
          aria-label="Notifications"
          aria-current={
            isUnder(pathname, '/notifications') ? 'page' : undefined
          }
        >
          <IconBell size={18} stroke={1.8} aria-hidden />
        </Link>
        <Text component="span" className={classes.date}>
          {dayjs().format('ddd, MMM D')}
        </Text>
        <AccountMenu />
      </div>
    </header>
  );
}
