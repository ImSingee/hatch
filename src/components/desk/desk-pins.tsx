import { Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AppGlyph } from '~components/apps/app-glyph';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';
import classes from './desk-pins.module.css';

/**
 * Pinned Apps and Workflows as a grid on the desk. Shown only below 560
 * wide, where the dock is replaced by the tab bar; pins are managed from All
 * apps and Workflows there.
 */
export function DeskPins() {
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: workflows } = useQuery(workflowsQueryOptions);
  const pinnedWorkflows = (workflows ?? []).filter((w) => w.pinned);

  return (
    <div className={classes.root}>
      <section aria-labelledby="desk-pins-apps" className={classes.section}>
        <div className={classes.head}>
          <h2 id="desk-pins-apps" className={classes.heading}>
            Apps
          </h2>
          <Link to="/apps" className={classes.more}>
            All apps
          </Link>
        </div>
        {pins?.length ? (
          <div className={classes.grid}>
            {pins.map((pin) => (
              <Link
                key={pin.id}
                to="/app/$appSlug"
                params={{ appSlug: pin.appSlug }}
                hash={pin.entryHash ?? undefined}
                className={classes.item}
              >
                <AppGlyph name={pin.label} seed={pin.appId} size="lg" />
                <span className={classes.name}>{pin.label}</span>
              </Link>
            ))}
          </div>
        ) : (
          <Text size="sm" c="dimmed">
            Pin an App from All apps to keep it here.
          </Text>
        )}
      </section>

      {pinnedWorkflows.length > 0 ? (
        <section
          aria-labelledby="desk-pins-workflows"
          className={classes.section}
        >
          <div className={classes.head}>
            <h2 id="desk-pins-workflows" className={classes.heading}>
              Workflows
            </h2>
            <Link to="/workflows" className={classes.more}>
              All workflows
            </Link>
          </div>
          <div className={classes.grid}>
            {pinnedWorkflows.map((w) => (
              <Link
                key={w.id}
                to="/workflow/$workflowSlug"
                params={{ workflowSlug: w.slug }}
                className={classes.item}
                data-shape="workflow"
              >
                <AppGlyph icon={false} name={w.name} seed={w.id} size="lg" />
                <span className={classes.name}>{w.name}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
