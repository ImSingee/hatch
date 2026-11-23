import { Skeleton, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconPlus } from '@tabler/icons-react';
import { AppGlyph } from '~components/apps/app-glyph';
import { appsQueryOptions } from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';
import classes from './desk-tiles.module.css';

/** Two rows of App tiles at the default width; the rest live in All apps. */
const DESK_TILE_LIMIT = 14;

/**
 * App tiles on the desk, under the widgets.
 *
 * With the dock visible the desk lists the Apps that are not in the dock, so
 * nothing shows twice, followed by All apps and New app. Below 560, where
 * the tab bar replaces the dock, it lists the pinned Apps and Workflows
 * instead. Both lists render; CSS shows the one that fits the width.
 */
export function DeskTiles() {
  const apps = useQuery(appsQueryOptions);
  const pins = useQuery(sidebarItemsQueryOptions);
  const workflows = useQuery(workflowsQueryOptions);
  const live = (apps.data ?? []).filter((app) => app.status !== 'archived');
  const pinnedAppIds = new Set((pins.data ?? []).map((pin) => pin.appId));
  const unpinned = live.filter((app) => !pinnedAppIds.has(app.id));
  const pinnedWorkflows = (workflows.data ?? []).filter((w) => w.pinned);
  const loading = apps.isPending || pins.isPending;

  return (
    <>
      <section aria-labelledby="desk-tiles-desk" className={classes.wide}>
        <div className={classes.head}>
          <h2 id="desk-tiles-desk" className={classes.heading}>
            Desk
          </h2>
          <Link to="/apps" className={classes.more}>
            All apps{apps.data ? ` (${live.length})` : ''} ›
          </Link>
        </div>
        <div className={classes.grid}>
          {loading
            ? Array.from({ length: 6 }, (_, index) => (
                <div key={index} className={classes.item} aria-hidden>
                  <Skeleton
                    width="var(--size-dock-tile)"
                    height="var(--size-dock-tile)"
                    radius="md"
                  />
                  <Skeleton height={10} width={48} radius="sm" />
                </div>
              ))
            : unpinned.slice(0, DESK_TILE_LIMIT).map((app) => (
                <Link
                  key={app.id}
                  to="/app/$appSlug"
                  params={{ appSlug: app.slug }}
                  className={classes.item}
                >
                  <span className={classes.tile}>
                    <AppGlyph name={app.name} seed={app.id} size="desk" />
                  </span>
                  <span className={classes.name}>{app.name}</span>
                </Link>
              ))}
          <Link to="/apps" className={classes.item}>
            <span className={`${classes.tile} ${classes.allApps}`} aria-hidden>
              <span />
              <span />
              <span />
              <span />
            </span>
            <span className={classes.name}>All apps</span>
          </Link>
          <Link to="/agent" className={classes.item}>
            <span className={`${classes.tile} ${classes.add}`} aria-hidden>
              <IconPlus size={18} stroke={2.4} />
            </span>
            <span className={classes.name}>New app</span>
          </Link>
        </div>
      </section>

      <div className={classes.narrow}>
        <section aria-labelledby="desk-tiles-apps" className={classes.section}>
          <div className={classes.head}>
            <h2 id="desk-tiles-apps" className={classes.eyebrow}>
              Apps
            </h2>
            <Link to="/apps" className={classes.more}>
              All apps{apps.data ? ` (${live.length})` : ''} ›
            </Link>
          </div>
          {pins.data?.length ? (
            <div className={classes.grid}>
              {pins.data.map((pin) => (
                <Link
                  key={pin.id}
                  to="/app/$appSlug"
                  params={{ appSlug: pin.appSlug }}
                  hash={pin.entryHash ?? undefined}
                  className={classes.item}
                >
                  <span className={classes.tile}>
                    <AppGlyph name={pin.label} seed={pin.appId} size="desk" />
                  </span>
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
            aria-labelledby="desk-tiles-workflows"
            className={classes.section}
          >
            <div className={classes.head}>
              <h2 id="desk-tiles-workflows" className={classes.eyebrow}>
                Workflows
              </h2>
              <Link to="/workflows" className={classes.more}>
                All workflows ›
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
                  <span className={classes.tile}>
                    <AppGlyph
                      icon={false}
                      name={w.name}
                      seed={w.id}
                      size="desk"
                    />
                  </span>
                  <span className={classes.name}>{w.name}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
