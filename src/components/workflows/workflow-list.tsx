import { Badge, Button, ThemeIcon } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconClock,
  IconHandClick,
  IconPinFilled,
  IconPlus,
  IconRepeat,
  IconTimeline,
  IconWebhook,
} from '@tabler/icons-react';
import { AppGlyph } from '~components/apps/app-glyph';
import {
  EmptyState,
  PageHeading,
  Section,
  WindowBody,
} from '~components/page/page';
import { StatusBadge } from '~components/system/status-badge';
import { formatRelative } from '~lib/format';
import {
  latestWorkflowRunsQueryOptions,
  workflowOpsQueryOptions,
} from '~queries/workflows';
import type { WorkflowListItem } from '~server/workflows';
import { RunStatusBadge } from '~components/runs/run-status';
import classes from './workflow-list.module.css';

const DESCRIPTION =
  'Headless, code-based jobs the Agent builds — run them manually, on a schedule, or via webhook. Every run keeps a step-by-step record.';

const WAYS = [
  {
    kind: 'Manual',
    title: 'Fill a form, press Run',
    text: 'Hatch builds a form from the workflow’s inputs. Fill it in and run; the result shows right below.',
    icon: <IconHandClick size={20} stroke={1.8} />,
    color: 'primary',
  },
  {
    kind: 'Schedule',
    title: 'Runs on its own',
    text: 'Give a workflow a schedule and it runs on time without you — for checks, syncs and digests.',
    icon: <IconClock size={20} stroke={1.8} />,
    color: 'amber',
  },
  {
    kind: 'Webhook',
    title: 'Woken by another service',
    text: 'A workflow can have a webhook address. A request to it starts a run with the request as input.',
    icon: <IconWebhook size={20} stroke={1.8} />,
    color: 'teal',
  },
];

/** The Workflows window: every workflow as a card, and how they run. */
export function WorkflowList({ workflows }: { workflows: WorkflowListItem[] }) {
  // One newest run per workflow: a global recent list would leave out
  // workflows that run rarely next to ones that run every minute.
  const { data: runs } = useQuery(latestWorkflowRunsQueryOptions);
  const count = workflows.length;

  return (
    <WindowBody>
      <PageHeading
        meta={`${count} workflow${count === 1 ? '' : 's'}`}
        description={DESCRIPTION}
        actions={
          <>
            <Button
              component={Link}
              to="/executions"
              variant="default"
              size="md"
              leftSection={<IconTimeline size={16} stroke={1.8} />}
            >
              Executions
            </Button>
            <Button
              component={Link}
              to="/agent"
              size="md"
              leftSection={<IconPlus size={16} stroke={2} />}
            >
              New workflow
            </Button>
          </>
        }
      />

      {count === 0 ? (
        <EmptyState
          tone="accent"
          icon={<IconRepeat size={26} stroke={1.6} />}
          title="No workflows yet"
          actions={
            <Button
              component={Link}
              to="/agent"
              leftSection={<IconPlus size={16} stroke={2} />}
            >
              Build your first workflow
            </Button>
          }
        >
          Ask the Agent for a periodic or repetitive task — a daily digest, a
          sync job, an inbound-webhook automation — and it will write, bundle,
          and deploy it here.
        </EmptyState>
      ) : (
        <Section title="Your workflows">
          <div className={classes.grid}>
            {workflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                lastRun={runs?.find((run) => run.workflowId === workflow.id)}
              />
            ))}
            <Link to="/agent" className={classes.newCard}>
              <span className={classes.newTile} aria-hidden>
                <IconPlus size={24} stroke={2} />
              </span>
              <span className={classes.newTitle}>
                Ask the Agent for a new workflow
              </span>
              <span className={classes.newText}>
                Describe what you want done automatically. The Agent writes the
                code, generates the run form and deploys it; add a schedule or a
                webhook later.
              </span>
              <span className={classes.newLink}>Start in the Agent ›</span>
            </Link>
          </div>
        </Section>
      )}

      <Section
        title="What workflows can do"
        meta="One workflow can use all three at once"
      >
        <div className={classes.ways}>
          {WAYS.map((way) => (
            <article key={way.kind} className={classes.way}>
              <div className={classes.wayHead}>
                <ThemeIcon size={40} radius="md" color={way.color}>
                  {way.icon}
                </ThemeIcon>
                <div>
                  <span className={classes.wayKind}>{way.kind}</span>
                  <h4 className={classes.wayTitle}>{way.title}</h4>
                </div>
              </div>
              <p className={classes.wayText}>{way.text}</p>
            </article>
          ))}
        </div>
      </Section>
    </WindowBody>
  );
}

type RunSummary = {
  status: Parameters<typeof RunStatusBadge>[0]['status'];
  startedAt: string | null;
  createdAt: string;
};

function WorkflowCard({
  workflow,
  lastRun,
}: {
  workflow: WorkflowListItem;
  lastRun?: RunSummary;
}) {
  const { data: ops } = useQuery(workflowOpsQueryOptions(workflow.id));
  const cronJobs = ops?.cron.jobs.length ?? 0;

  return (
    <article className={classes.card}>
      <div className={classes.cardHead}>
        <AppGlyph
          size="xl"
          icon={false}
          shape="workflow"
          name={workflow.name}
          seed={workflow.id}
        />
        <div className={classes.cardText}>
          <div className={classes.cardTitleRow}>
            <h4 className={classes.cardTitle}>{workflow.name}</h4>
            {workflow.pinned ? (
              <Badge
                color="dark"
                variant="filled"
                leftSection={<IconPinFilled size={10} />}
              >
                Pinned
              </Badge>
            ) : null}
            <StatusBadge status={workflow.status} />
          </div>
          <p className={classes.cardDescription}>
            {workflow.description || 'No description yet.'}
          </p>
          <span className={classes.cardMeta}>
            Updated {formatRelative(workflow.updatedAt)}
          </span>
        </div>
      </div>
      <dl className={classes.facts}>
        <div className={classes.fact}>
          <dt>Manual</dt>
          <dd>Run form</dd>
        </div>
        <div className={classes.fact}>
          <dt>Schedule</dt>
          <dd>
            {ops
              ? cronJobs > 0
                ? ops.cron.jobs.map((job) => job.schedule).join(', ')
                : 'Not set'
              : '…'}
          </dd>
        </div>
        <div className={classes.fact}>
          <dt>Webhook</dt>
          <dd>{ops ? (ops.webhook.enabled ? 'On' : 'Not set') : '…'}</dd>
        </div>
        <div className={classes.fact}>
          <dt>Last run</dt>
          <dd>
            {lastRun ? (
              <>
                <RunStatusBadge status={lastRun.status} />{' '}
                {formatRelative(lastRun.startedAt ?? lastRun.createdAt)}
              </>
            ) : (
              'Never'
            )}
          </dd>
        </div>
      </dl>
      <div className={classes.cardActions}>
        <Button
          size="md"
          renderRoot={(props) => (
            <Link
              to="/workflow/$workflowSlug"
              params={{ workflowSlug: workflow.slug }}
              {...props}
            />
          )}
        >
          Open
        </Button>
        <Button
          size="md"
          variant="default"
          renderRoot={(props) => (
            <Link
              to="/workflow/$workflowSlug/manage"
              params={{ workflowSlug: workflow.slug }}
              {...props}
            />
          )}
        >
          Manage
        </Button>
      </div>
    </article>
  );
}
