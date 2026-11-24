import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconPlayerPlay,
  IconSettings,
  IconSparkles,
  IconTimeline,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeskWindow } from '~components/desk/window';
import { LinkTabs, WindowBody } from '~components/page/page';
import { StatusBadge } from '~components/system/status-badge';
import { useI18n } from '~i18n';
import type { AppDetail } from '~server/apps';
import classes from './tasks-window.module.css';

export type TasksPage = 'run' | 'runs';

/**
 * The window of an App's tasks: the App, how to change it, and the task
 * pages (Run, Runs) as tabs. Each page is its own route.
 */
export function TasksWindow({
  app,
  page,
  title,
  children,
}: {
  app: AppDetail;
  page: TasksPage;
  /** Window title suffix, e.g. a task name. */
  title?: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const params = { appSlug: app.slug };
  return (
    <DeskWindow
      fill
      title={
        title
          ? `${app.name} · ${title}`
          : t('tasks.window.title', { app: app.name })
      }
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      badge={<StatusBadge status={app.status} />}
      closeTo={{
        link: { to: '/app/$appSlug/manage', params },
        label: t('tasks.window.closeLabel', { app: app.name }),
      }}
    >
      <WindowBody>
        <header className={classes.header}>
          <AppGlyph name={app.name} seed={app.id} size="hero" />
          <div className={classes.identity}>
            <div className={classes.nameRow}>
              <h2 className={classes.name}>{app.name}</h2>
            </div>
            {app.description ? (
              <p className={classes.description}>{app.description}</p>
            ) : null}
            <span className={classes.meta}>
              {t('tasks.window.meta', { slug: app.slug })}
            </span>
          </div>
          <div className={classes.actions}>
            <Button
              size="md"
              variant="default"
              component={Link}
              to="/agent"
              leftSection={<IconSparkles size={16} stroke={1.8} />}
            >
              {t('tasks.window.editWithAgent')}
            </Button>
            <Button
              size="md"
              variant="default"
              renderRoot={(props) => (
                <Link to="/app/$appSlug/manage" params={params} {...props} />
              )}
              leftSection={<IconSettings size={16} stroke={1.8} />}
            >
              {t('common.manage')}
            </Button>
          </div>
        </header>
        <LinkTabs
          label={t('tasks.window.tabsLabel')}
          tabs={[
            {
              key: 'run',
              label: t('tasks.window.tab.run'),
              icon: <IconPlayerPlay size={16} stroke={1.8} />,
              link: { to: '/app/$appSlug/tasks', params },
              current: page === 'run',
            },
            {
              key: 'runs',
              label: t('tasks.runs.title'),
              icon: <IconTimeline size={16} stroke={1.8} />,
              link: { to: '/app/$appSlug/tasks/runs', params },
              current: page === 'runs',
            },
          ]}
        />
        {children}
      </WindowBody>
    </DeskWindow>
  );
}
