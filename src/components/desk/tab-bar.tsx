import { Link, useRouterState } from '@tanstack/react-router';
import {
  IconHome,
  IconLayoutGrid,
  IconSparkles,
  IconUser,
} from '@tabler/icons-react';
import { useI18n } from '~i18n';
import { DESK_HOME } from './paths';
import classes from './tab-bar.module.css';

/**
 * The dock's stand-in below 560 wide: four destinations instead of the pins.
 * Apps lists every App, pinned ones marked.
 */
export function TabBar() {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = (to: string) =>
    pathname === to || pathname.startsWith(`${to}/`) ? 'page' : undefined;

  return (
    <nav aria-label={t('nav.tabs')} className={classes.bar}>
      <Link
        to={DESK_HOME}
        className={classes.tab}
        aria-current={current(DESK_HOME)}
      >
        <span className={classes.icon}>
          <IconHome size={22} stroke={2} aria-hidden />
        </span>
        {t('nav.desk')}
      </Link>
      <Link to="/apps" className={classes.tab} aria-current={current('/apps')}>
        <span className={classes.icon}>
          <IconLayoutGrid size={22} stroke={2} aria-hidden />
        </span>
        {t('nav.apps')}
      </Link>
      <Link to="/agent" className={classes.tab} aria-label={t('nav.agent')}>
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
        {t('nav.me')}
      </Link>
    </nav>
  );
}
