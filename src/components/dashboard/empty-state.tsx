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
import { useI18n, type PlainTranslationKey } from '~i18n';
import classes from './empty-state.module.css';

/** Starter prompts; each label is also the prompt the Agent receives. */
const STARTER_IDEAS: PlainTranslationKey[] = [
  'dashboard.idea.habit',
  'dashboard.idea.reading',
  'dashboard.idea.budget',
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
  const { t } = useI18n();
  if (state === 'editing')
    return (
      <div className={classes.dropZone}>
        <EmptyState variant="dashed" title={t('dashboard.empty.editingTitle')}>
          {t('dashboard.empty.editingBody')}
        </EmptyState>
      </div>
    );

  if (state === 'empty-dashboard')
    return (
      <Panel>
        <EmptyState
          icon={<IconLayoutGrid size={26} stroke={1.6} />}
          title={t('dashboard.empty.cleanTitle')}
          actions={
            onAddWidget ? (
              <Button
                type="button"
                leftSection={<IconPlus size={16} stroke={2} />}
                onClick={onAddWidget}
              >
                {t('dashboard.empty.addWidget')}
              </Button>
            ) : null
          }
        >
          {t('dashboard.empty.cleanBody')}
        </EmptyState>
      </Panel>
    );

  if (state === 'no-widgets')
    return (
      <Panel>
        <EmptyState
          icon={<IconStack2 size={26} stroke={1.6} />}
          title={t('dashboard.empty.noWidgetsTitle')}
          actions={
            <>
              <Button component={Link} to="/apps" variant="default">
                {t('dashboard.empty.browseApps')}
              </Button>
              <Button
                renderRoot={(props) => (
                  <Link
                    to="/agent"
                    search={{ prompt: t('dashboard.agentPrompt.addWidget') }}
                    {...props}
                  />
                )}
                leftSection={<IconSparkles size={16} stroke={1.8} />}
              >
                {t('dashboard.empty.askAgent')}
              </Button>
            </>
          }
        >
          {t('dashboard.empty.noWidgetsBody')}
        </EmptyState>
      </Panel>
    );

  return (
    <Panel>
      <EmptyState
        icon={<IconSparkles size={26} stroke={1.6} />}
        tone="accent"
        title={t('dashboard.empty.welcomeTitle')}
        actions={
          <Button
            component={Link}
            to="/agent"
            size="md"
            leftSection={<IconSparkles size={18} stroke={1.8} />}
          >
            {t('dashboard.empty.buildFirst')}
          </Button>
        }
      >
        {t('dashboard.empty.welcomeBody')}
      </EmptyState>
      <div className={classes.ideas}>
        <span className={classes.ideasLabel}>
          {t('dashboard.empty.tryStarting')}
        </span>
        <Group gap="xs" justify="center">
          {STARTER_IDEAS.map((idea) => (
            <Button
              key={idea}
              renderRoot={(props) => (
                <Link to="/agent" search={{ prompt: t(idea) }} {...props} />
              )}
              variant="default"
              size="xs"
              radius="xl"
            >
              {t(idea)}
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
