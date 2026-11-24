import { Alert, Anchor, Button, Checkbox, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import { Trans } from 'react-i18next';
import { DEVICE_CLIENTS } from '~auth/device-clients';
import { useI18n } from '~i18n';
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
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(false);
  const busy = pending !== null || switching;

  return (
    <>
      <ViewHeader
        title={t('cliAuth.review.title', {
          client: DEVICE_CLIENTS[request.clientId].name,
        })}
        focus
      >
        <Trans
          t={t}
          i18nKey={
            account !== null
              ? 'cliAuth.review.signingInAs'
              : 'cliAuth.review.signingInAsYou'
          }
          values={{ account, host: window.location.host }}
          components={{
            account: (
              <Text span inherit fw={600} c="var(--mantine-color-text)" />
            ),
          }}
        />
      </ViewHeader>

      <section
        className={classes.sheet}
        aria-label={t('cliAuth.review.requestLabel')}
      >
        <div className={classes.codeBlock}>
          <DeviceCode code={request.userCode} />
          <Text size="sm" className={classes.codeCaption}>
            {t('cliAuth.review.compareCode')}
          </Text>
        </div>

        <Text className={classes.access}>
          <Trans
            t={t}
            i18nKey="cliAuth.review.access"
            components={{ strong: <strong /> }}
          />
        </Text>

        {switchFailed ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={18} stroke={1.75} />}
            role="alert"
          >
            {t('cliAuth.review.switchFailed')}
          </Alert>
        ) : null}

        <div className={classes.decision}>
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            label={t('cliAuth.review.confirm')}
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
              {t('cliAuth.review.deny')}
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
              {t('cliAuth.review.approve')}
            </Button>
          </div>
        </div>
      </section>

      <Text size="sm" c="dimmed" ta="center" className={classes.footnote}>
        {t('cliAuth.review.warning')}
      </Text>
      <Text size="sm" c="dimmed" ta="center">
        {account !== null
          ? t('cliAuth.review.notAccount', { account })
          : t('cliAuth.review.notRightAccount')}{' '}
        <Anchor
          component="button"
          type="button"
          size="sm"
          disabled={busy}
          onClick={onSwitchAccount}
        >
          {t('cliAuth.useDifferentAccount')}
        </Anchor>
      </Text>
    </>
  );
}
