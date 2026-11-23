import { Alert, Anchor, Button, Checkbox, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { DEVICE_CLIENTS } from '~auth/device-clients';
import type { DeviceDecision, DeviceRequest } from './device-api';
import { DeviceCode, ViewHeader } from './layout';
import classes from './device-approval.module.css';

type RequestReviewProps = {
  request: DeviceRequest;
  /** The signed-in account the device will act as. */
  account: string | null;
  /** The decision currently in flight, if any. */
  pending: DeviceDecision | null;
  onDecide: (decision: DeviceDecision) => void;
  /** Releasing the claim to switch account is in flight or done. */
  switching: boolean;
  /** The last attempt to switch account failed; this account is still in. */
  switchFailed: boolean;
  onSwitchAccount: () => void;
};

/**
 * The decision screen: who is signing in where, the code to compare, and what
 * approving grants. Approve needs an explicit confirmation; Deny does not.
 */
export function RequestReview({
  request,
  account,
  pending,
  onDecide,
  switching,
  switchFailed,
  onSwitchAccount,
}: RequestReviewProps) {
  const [confirmed, setConfirmed] = useState(false);
  const busy = pending !== null || switching;

  return (
    <>
      <ViewHeader
        title={`Approve ${DEVICE_CLIENTS[request.clientId].name}?`}
        focus
      >
        Signing in as{' '}
        <Text span inherit fw={600} c="var(--mantine-color-text)">
          {account ?? 'your account'}
        </Text>{' '}
        on {window.location.host}
      </ViewHeader>

      <section className={classes.sheet} aria-label="Device request">
        <div className={classes.codeBlock}>
          <DeviceCode code={request.userCode} />
          <Text size="sm" className={classes.codeCaption}>
            Check that it matches your device
          </Text>
        </div>

        <Text className={classes.access}>
          It will get <strong>full access to your Hatch account</strong>, the
          same as signing in here, until it signs out.
        </Text>

        {switchFailed ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={18} stroke={1.75} />}
            role="alert"
          >
            Couldn’t switch account, so you’re still signed in here. Try again.
          </Alert>
        ) : null}

        <div className={classes.decision}>
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            label="I started this, and the code matches my device"
            classNames={{ label: classes.confirmLabel }}
          />
          <div className={classes.actions}>
            <Button
              type="button"
              variant="default"
              size="md"
              loading={pending === 'deny'}
              disabled={busy && pending !== 'deny'}
              onClick={() => onDecide('deny')}
            >
              Deny
            </Button>
            <Button
              type="button"
              size="md"
              loading={pending === 'approve'}
              disabled={!confirmed || (busy && pending !== 'approve')}
              onClick={() => {
                if (confirmed) onDecide('approve');
              }}
            >
              Approve
            </Button>
          </div>
        </div>
      </section>

      <Text size="sm" c="dimmed" ta="center" className={classes.footnote}>
        Didn’t start this? Deny it. Approving would let someone else use your
        account.
      </Text>
      <Text size="sm" c="dimmed" ta="center">
        Not {account ?? 'the right account'}?{' '}
        <Anchor
          component="button"
          type="button"
          size="sm"
          disabled={busy}
          onClick={onSwitchAccount}
        >
          Use a different account
        </Anchor>
      </Text>
    </>
  );
}
