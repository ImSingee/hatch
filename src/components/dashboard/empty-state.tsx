import { Button, Group } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconLayoutGrid,
  IconPlus,
  IconSparkles,
  IconStack2,
} from '@tabler/icons-react';
import classes from './empty-state.module.css';

const STARTER_IDEAS = [
  'A daily habit tracker',
  'A reading list',
  'A simple budget tracker',
];

export type DashboardEmptyStateKind =
  | 'no-apps'
  | 'no-widgets'
  | 'empty-dashboard'
  /** In the layout editor: widgets come from the panel beside it. */
  | 'editing';

/**
 * What the widget area shows with no widget on it. Each case says why it is
 * empty and offers the one next step that fills it.
 */
export function DashboardEmptyState({
  state,
  onAddWidget,
}: {
  state: DashboardEmptyStateKind;
  onAddWidget?: () => void;
}) {
  if (state === 'editing')
    return (
      <div className={classes.root} data-variant="dashed">
        <strong className={classes.title}>No widgets on this desk yet</strong>
        <p className={classes.body}>
          Pick one from Add widgets to place it here.
        </p>
      </div>
    );

  if (state === 'empty-dashboard')
    return (
      <div className={classes.root}>
        <span className={classes.tile} aria-hidden>
          <IconLayoutGrid size={26} stroke={1.6} />
        </span>
        <h2 className={classes.title}>A clean desk</h2>
        <p className={classes.body}>
          Add a widget from one of your Apps and shape this dashboard around
          what you check every day.
        </p>
        {onAddWidget ? (
          <Button
            type="button"
            leftSection={<IconPlus size={16} stroke={2} />}
            onClick={onAddWidget}
          >
            Add widget
          </Button>
        ) : null}
      </div>
    );

  if (state === 'no-widgets')
    return (
      <div className={classes.root}>
        <span className={classes.tile} aria-hidden>
          <IconStack2 size={26} stroke={1.6} />
        </span>
        <h2 className={classes.title}>No widgets to add yet</h2>
        <p className={classes.body}>
          None of your Apps offers a widget. Ask the Agent to add one to an App
          you use.
        </p>
        <Group gap="sm" justify="center">
          <Button component={Link} to="/apps" variant="default">
            Browse apps
          </Button>
          <Button
            renderRoot={(props) => (
              <Link
                to="/agent"
                search={{ prompt: 'Add a dashboard widget to ' }}
                {...props}
              />
            )}
            leftSection={<IconSparkles size={16} stroke={1.8} />}
          >
            Ask the Agent
          </Button>
        </Group>
      </div>
    );

  return (
    <div className={classes.root}>
      <span className={classes.tile} data-tone="accent" aria-hidden>
        <IconSparkles size={26} stroke={1.6} />
      </span>
      <h2 className={classes.title}>Welcome to Hatch</h2>
      <p className={classes.body}>
        Describe an App in plain language and the Agent builds and deploys it.
        Your Apps then live in the dock, and their widgets on this desk.
      </p>
      <Button
        component={Link}
        to="/agent"
        size="md"
        leftSection={<IconSparkles size={18} stroke={1.8} />}
      >
        Build your first app
      </Button>
      <div className={classes.ideas}>
        <span className={classes.ideasLabel}>Try starting with</span>
        <Group gap="xs" justify="center">
          {STARTER_IDEAS.map((idea) => (
            <Button
              key={idea}
              renderRoot={(props) => (
                <Link to="/agent" search={{ prompt: idea }} {...props} />
              )}
              variant="default"
              size="xs"
              radius="xl"
            >
              {idea}
            </Button>
          ))}
        </Group>
      </div>
    </div>
  );
}
