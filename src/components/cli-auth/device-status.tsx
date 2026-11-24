import { Button, Group, Text, ThemeIcon } from '@mantine/core';
import {
  IconBan,
  IconClockX,
  IconCloudX,
  IconDevices,
  IconHistory,
  IconHourglassHigh,
  IconLogin2,
  IconWorldX,
  type Icon,
} from '@tabler/icons-react';
import { type ReactNode, useEffect } from 'react';
import { Trans } from 'react-i18next';
import { DEVICE_CLIENTS, type DeviceClientId } from '~auth/device-clients';
import { useI18n, type PlainTranslationKey } from '~i18n';
import { formatUserCode, type DeviceOutcome } from './device-api';
import { ViewHeader } from './layout';
import { retryWait, type Problem } from './problems';
import classes from './device-approval.module.css';

type Action = 'new-code' | 'sign-in' | 'recheck' | 'home';

type StatusCopy = {
  icon?: Icon;
  color?: string;
  title: PlainTranslationKey;
  /** `null`: the view writes the body (it includes the server's wait). */
  body: PlainTranslationKey | null;
  actions: Action[];
};

/** A status step's copy, translated for display. */
type StatusText = Omit<StatusCopy, 'title' | 'body'> & {
  title: string;
  body: string;
};

const PROBLEMS: Record<Problem, StatusCopy> = {
  expired: {
    icon: IconClockX,
    color: 'gray',
    title: 'cliAuth.problem.expired.title',
    body: 'cliAuth.problem.expired.body',
    actions: ['new-code'],
  },
  closed: {
    icon: IconHistory,
    color: 'gray',
    title: 'cliAuth.problem.closed.title',
    body: 'cliAuth.problem.closed.body',
    actions: ['new-code'],
  },
  elsewhere: {
    icon: IconDevices,
    color: 'yellow',
    title: 'cliAuth.problem.elsewhere.title',
    body: 'cliAuth.problem.elsewhere.body',
    actions: ['new-code'],
  },
  'signed-out': {
    icon: IconLogin2,
    color: 'gray',
    title: 'cliAuth.problem.signedOut.title',
    body: 'cliAuth.problem.signedOut.body',
    actions: ['sign-in'],
  },
  origin: {
    icon: IconWorldX,
    color: 'red',
    title: 'cliAuth.problem.origin.title',
    body: 'cliAuth.problem.origin.body',
    actions: ['home'],
  },
  'rate-limited': {
    icon: IconHourglassHigh,
    color: 'yellow',
    title: 'cliAuth.problem.rateLimited.title',
    body: null,
    actions: ['recheck'],
  },
  unconfirmed: {
    icon: IconCloudX,
    color: 'yellow',
    title: 'cliAuth.problem.unconfirmed.title',
    body: 'cliAuth.problem.unconfirmed.body',
    actions: ['recheck', 'new-code'],
  },
};

const OUTCOMES: Record<
  DeviceOutcome,
  StatusCopy & { body: PlainTranslationKey }
> = {
  approved: {
    title: 'cliAuth.outcome.approved.title',
    body: 'cliAuth.outcome.approved.body',
    actions: [],
  },
  denied: {
    icon: IconBan,
    color: 'gray',
    title: 'cliAuth.outcome.denied.title',
    body: 'cliAuth.outcome.denied.body',
    actions: [],
  },
};

const ACTION_LABEL: Record<Action, PlainTranslationKey> = {
  'new-code': 'cliAuth.action.newCode',
  'sign-in': 'cliAuth.action.signIn',
  recheck: 'cliAuth.action.recheck',
  home: 'cliAuth.action.home',
};

type Handlers = {
  onNewCode: () => void;
  onSignIn: () => void;
  onRecheck: () => void;
  /** The action currently in flight, shown as loading. */
  pending: 'recheck' | null;
};

export function ProblemView({
  problem,
  userCode,
  retryAfter,
  handlers,
}: {
  problem: Problem;
  userCode: string;
  /** Server-reported wait for a rate-limited decision, in seconds. */
  retryAfter: number | null;
  handlers: Handlers;
}) {
  const { t } = useI18n();
  const base = PROBLEMS[problem];
  const copy: StatusText = {
    ...base,
    title: t(base.title),
    body: base.body
      ? t(base.body)
      : t('cliAuth.problem.rateLimited.body', {
          wait: retryWait(t, retryAfter),
        }),
  };
  return (
    <StatusLayout copy={copy} userCode={userCode}>
      <Group justify="center" gap="sm">
        {copy.actions.map((action, index) => (
          <ActionButton
            key={action}
            action={action}
            primary={index === 0}
            handlers={handlers}
          />
        ))}
      </Group>
    </StatusLayout>
  );
}

export function OutcomeView({
  outcome,
  userCode,
  clientId,
}: {
  outcome: DeviceOutcome;
  userCode: string;
  clientId: DeviceClientId;
}) {
  const { t } = useI18n();
  const client = DEVICE_CLIENTS[clientId];
  const returnUrl = outcome === 'approved' ? client.returnUrl : null;
  // An app on this computer comes back to the front by itself; the button
  // stays for a browser that asks before opening another app.
  useEffect(() => {
    if (returnUrl) window.location.assign(returnUrl);
  }, [returnUrl]);
  const base = OUTCOMES[outcome];
  if (!returnUrl)
    return (
      <StatusLayout
        copy={{ ...base, title: t(base.title), body: t(base.body) }}
        userCode={userCode}
      />
    );
  return (
    <StatusLayout
      copy={{
        ...base,
        title: t(base.title),
        body: t('cliAuth.outcome.approved.appBody', { client: client.name }),
      }}
      userCode={userCode}
    >
      <Button component="a" href={returnUrl} radius="md">
        {t('cliAuth.outcome.openClient', { client: client.name })}
      </Button>
    </StatusLayout>
  );
}

function StatusLayout({
  copy,
  userCode,
  children,
}: {
  copy: StatusText;
  userCode: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={classes.status}>
      {copy.icon ? (
        <ThemeIcon
          size={52}
          radius="xl"
          variant="light"
          color={copy.color}
          aria-hidden
        >
          <copy.icon size={26} stroke={1.6} />
        </ThemeIcon>
      ) : null}
      <ViewHeader title={copy.title} focus>
        {copy.body}
      </ViewHeader>
      {userCode ? (
        <Text size="sm" c="dimmed">
          <Trans
            t={t}
            i18nKey="cliAuth.status.code"
            values={{ code: formatUserCode(userCode) }}
            components={{ code: <span className={classes.inlineCode} /> }}
          />
        </Text>
      ) : null}
      {children}
    </div>
  );
}

function ActionButton({
  action,
  primary,
  handlers,
}: {
  action: Action;
  primary: boolean;
  handlers: Handlers;
}) {
  const { t } = useI18n();
  const variant = primary ? 'filled' : 'default';
  if (action === 'home')
    return (
      <Button component="a" href="/dashboard" variant={variant}>
        {t(ACTION_LABEL.home)}
      </Button>
    );
  const onClick = {
    'new-code': handlers.onNewCode,
    'sign-in': handlers.onSignIn,
    recheck: handlers.onRecheck,
  }[action];
  const loading = handlers.pending === action;
  return (
    <Button
      type="button"
      variant={variant}
      loading={loading}
      disabled={handlers.pending !== null && !loading}
      onClick={onClick}
    >
      {t(ACTION_LABEL[action])}
    </Button>
  );
}
