import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconExternalLink } from '@tabler/icons-react';
import { Fragment, type ReactNode } from 'react';
import { useI18n } from '~i18n';
import type { AppListItem } from '~server/apps';
import classes from './chat.module.css';

/**
 * The head of a chat: its title, one line naming the model, the runner that
 * holds its workspace and the Apps it worked on, and a button that opens the
 * App when the chat is about exactly one App that can be opened. Facts the
 * chat does not have yet (no run, no App) are left out, not shown as blanks.
 */
export function SessionHeader({
  title,
  model,
  runnerId,
  apps,
}: {
  title: string;
  /** The model's display name, or its id when the catalog no longer has it. */
  model: string | null;
  runnerId: string | null;
  /** The Apps this chat edited, in name order. */
  apps: readonly AppListItem[];
}) {
  const { t } = useI18n();
  const facts: ReactNode[] = [];
  if (model) facts.push(model);
  if (runnerId) facts.push(runnerId);
  if (apps.length)
    facts.push(
      <>
        {`${t('agent.header.apps', { count: apps.length })} `}
        {apps.map((app, index) => (
          <Fragment key={app.id}>
            {index ? ', ' : null}
            <Link
              to="/app/$appSlug/manage"
              params={{ appSlug: app.slug }}
              className={classes.chatMetaLink}
            >
              {app.name}
            </Link>
          </Fragment>
        ))}
      </>,
    );
  const [only] = apps;
  const openable =
    apps.length === 1 &&
    only.status === 'deployed' &&
    Boolean(only.capabilities?.frontend);

  return (
    <div className={classes.chatHead}>
      <div className={classes.chatHeadText}>
        <h2 className={classes.chatTitle}>{title}</h2>
        {facts.length ? (
          <p className={classes.chatMeta}>
            {facts.map((fact, index) => (
              <Fragment key={index}>
                {index ? ' · ' : null}
                {fact}
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
      {openable ? (
        <Button
          variant="default"
          size="compact-md"
          leftSection={<IconExternalLink size={15} stroke={1.8} />}
          renderRoot={(props) => (
            <Link
              to="/app/$appSlug"
              params={{ appSlug: only.slug }}
              {...props}
            />
          )}
        >
          {t('agent.header.openApp', { name: only.name })}
        </Button>
      ) : null}
    </div>
  );
}
