import { Button, Group } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconLayoutGrid,
  IconPlus,
  IconSparkles,
  IconStack2,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { EmptyState } from '~components/page/page';
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
 * empty and offers the one next step that fills it. The content is the
 * shared `EmptyState`; on the desk it sits in a widget panel so the desk
 * keeps its shape, and in the editor it is a dashed drop zone.
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
      <div className={classes.dropZone}>
        <EmptyState variant="dashed" title="No widgets on this desk yet">
          Pick one from Add widgets to place it here.
        </EmptyState>
      </div>
    );

  if (state === 'empty-dashboard')
    return (
      <Panel>
        <EmptyState
          icon={<IconLayoutGrid size={26} stroke={1.6} />}
          title="A clean desk"
          actions={
            onAddWidget ? (
              <Button
                type="button"
                leftSection={<IconPlus size={16} stroke={2} />}
                onClick={onAddWidget}
              >
                Add widget
              </Button>
            ) : null
          }
        >
          Add a widget from one of your Apps and shape this dashboard around
          what you check every day.
        </EmptyState>
      </Panel>
    );

  if (state === 'no-widgets')
    return (
      <Panel>
        <EmptyState
          icon={<IconStack2 size={26} stroke={1.6} />}
          title="No widgets to add yet"
          actions={
            <>
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
            </>
          }
        >
          None of your Apps offers a widget. Ask the Agent to add one to an App
          you use.
        </EmptyState>
      </Panel>
    );

  return (
    <Panel>
      <EmptyState
        icon={<IconSparkles size={26} stroke={1.6} />}
        tone="accent"
        title="Welcome to Hatch"
        actions={
          <Button
            component={Link}
            to="/agent"
            size="md"
            leftSection={<IconSparkles size={18} stroke={1.8} />}
          >
            Build your first app
          </Button>
        }
      >
        Describe an App in plain language and the Agent builds and deploys it.
        Your Apps then live in the dock, and their widgets on this desk.
      </EmptyState>
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
    </Panel>
  );
}

/** A widget panel on the desk that holds an empty state. */
function Panel({ children }: { children: ReactNode }) {
  return <div className={classes.panel}>{children}</div>;
}
