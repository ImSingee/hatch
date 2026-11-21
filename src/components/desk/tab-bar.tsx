import { Link, useRouterState } from '@tanstack/react-router';
import {
  IconHome,
  IconLayoutGrid,
  IconSparkles,
  IconUser,
} from '@tabler/icons-react';
import { DESK_HOME } from './paths';
import classes from './tab-bar.module.css';

/**
 * The dock's stand-in below 560 wide: four destinations instead of the pins,
 * which move onto the desk itself.
 */
export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = (to: string) =>
    pathname === to || pathname.startsWith(`${to}/`) ? 'page' : undefined;

  return (
    <nav aria-label="Tabs" className={classes.bar}>
      <Link
        to={DESK_HOME}
        className={classes.tab}
        aria-current={current(DESK_HOME)}
      >
        <span className={classes.icon}>
          <IconHome size={22} stroke={2} aria-hidden />
        </span>
        Desk
      </Link>
      <Link to="/apps" className={classes.tab} aria-current={current('/apps')}>
        <span className={classes.icon}>
          <IconLayoutGrid size={22} stroke={2} aria-hidden />
        </span>
        Apps
      </Link>
      <Link to="/agent" className={classes.tab} aria-label="Agent">
        <span className={classes.agent}>
          <IconSparkles size={24} stroke={2} aria-hidden />
        </span>
      </Link>
      <Link
        to="/settings"
        className={classes.tab}
        aria-current={current('/settings')}
      >
        <span className={classes.icon}>
          <IconUser size={22} stroke={2} aria-hidden />
        </span>
        Me
      </Link>
    </nav>
  );
}
