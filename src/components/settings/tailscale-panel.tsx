import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  Loader,
  PasswordInput,
  Radio,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconExternalLink,
  IconHelpCircle,
  IconInfoCircle,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import {
  type PlainTranslationKey,
  translateError,
  useErrorText,
  useI18n,
} from '~i18n';
import { tailscaleQueryOptions } from '~queries/tailscale';
import { configureTailscale } from '~server/tailscale';
import {
  tailscaleConfigSchema,
  tailscaleAuthKeySchema,
  tailscaleLoginUrlSchema,
  type TailscaleConfigureInput,
  type TailscaleStatus,
} from '~/tailscale';
import { openTailscaleAuthorization } from './tailscale-authorization';
import classes from './tailscale-panel.module.css';

const STATES = {
  disconnected: { label: 'tailscale.state.disconnected', color: 'gray' },
  starting: { label: 'tailscale.state.starting', color: 'blue' },
  'preparing-https': { label: 'tailscale.state.preparingHttps', color: 'blue' },
  'needs-login': { label: 'tailscale.state.needsLogin', color: 'blue' },
  'needs-approval': { label: 'tailscale.state.needsApproval', color: 'blue' },
  connected: { label: 'tailscale.state.connected', color: 'green' },
  error: { label: 'tailscale.state.error', color: 'red' },
} as const satisfies Record<
  TailscaleStatus['state'],
  { label: PlainTranslationKey; color: string }
>;

const LOGIN_METHODS = [
  {
    value: 'interactive',
    label: 'tailscale.method.interactive',
    description: 'tailscale.method.interactiveDescription',
  },
  {
    value: 'auth-key',
    label: 'tailscale.method.authKey',
    description: 'tailscale.method.authKeyDescription',
  },
] as const satisfies readonly {
  value: string;
  label: PlainTranslationKey;
  description: PlainTranslationKey;
}[];

type LoginMethod = (typeof LOGIN_METHODS)[number]['value'];

const DNS_SETTINGS_URL = 'https://login.tailscale.com/admin/dns';
const DEVICES_URL = 'https://login.tailscale.com/admin/machines';
const AUTH_KEYS_URL = 'https://login.tailscale.com/admin/settings/keys';

type HttpsPhase = NonNullable<TailscaleStatus['https']>['phase'];

// DNS settings only help when the certificate itself has stalled; a provider
// rate limit or a listener failure is not fixed there.
const HTTPS_PROBLEMS: Partial<
  Record<
    HttpsPhase,
    {
      title: PlainTranslationKey;
      badge: PlainTranslationKey;
      color: string;
      dnsSettings: boolean;
    }
  >
> = {
  'certificate-delayed': {
    title: 'tailscale.https.delayedTitle',
    badge: 'tailscale.https.delayedBadge',
    color: 'yellow',
    dnsSettings: true,
  },
  'rate-limited': {
    title: 'tailscale.https.rateLimitedTitle',
    badge: 'tailscale.https.rateLimitedBadge',
    color: 'yellow',
    dnsSettings: false,
  },
  'listener-error': {
    title: 'tailscale.https.listenerErrorTitle',
    badge: 'tailscale.state.error',
    color: 'red',
    dnsSettings: false,
  },
};

/**
 * The helper reports problems as English sentences. Its typed HTTPS phase and
 * DNS flags identify which sentence it sent, so those translate through their
 * `error.<code>` keys; any other message keeps the helper's English text in
 * English and a generic translated sentence in other languages.
 */
function statusMessageCode(status: TailscaleStatus): string | undefined {
  if (status.state !== 'error') return undefined;
  switch (status.https?.phase) {
    case 'certificate-delayed':
      return 'tailscale.status.certificateDelayed';
    case 'rate-limited':
      return 'tailscale.status.rateLimited';
    case 'listener-error':
      return 'tailscale.status.listenerError';
  }
  if (status.https || !status.dns) return undefined;
  const { magicDnsEnabled, httpsCertificatesEnabled } = status.dns;
  if (magicDnsEnabled === null) return 'tailscale.status.magicDnsUnknown';
  if (magicDnsEnabled === false && httpsCertificatesEnabled === false)
    return 'tailscale.status.dnsSettingsDisabled';
  if (magicDnsEnabled === false) return 'tailscale.status.magicDnsDisabled';
  if (httpsCertificatesEnabled === false)
    return 'tailscale.status.httpsCertificatesDisabled';
  return undefined;
}

function DnsSettingRow({
  name,
  enabled,
}: {
  name: string;
  enabled?: boolean | null;
}) {
  const { t } = useI18n();
  // A missing value means the helper could not read the setting, not that it
  // is off, so only an explicit false is reported as not enabled.
  const { label, Icon, color } =
    enabled === true
      ? {
          label: 'common.enabled' as const,
          Icon: IconCircleCheck,
          color: 'var(--mantine-color-green-7)',
        }
      : enabled === false
        ? {
            label: 'tailscale.dns.notEnabled' as const,
            Icon: IconCircleX,
            color: 'var(--mantine-color-red-7)',
          }
        : {
            label: 'common.unknown' as const,
            Icon: IconHelpCircle,
            color: 'var(--mantine-color-dimmed)',
          };
  return (
    <Table.Tr>
      <Table.Th scope="row" fw={400} pr="xl">
        {name}
      </Table.Th>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Icon size={16} color={color} aria-hidden />
          <Text span size="sm" fw={600}>
            {t(label)}
          </Text>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function ExternalButton({ href, label }: { href: string; label: string }) {
  return (
    <Button
      component="a"
      href={href}
      target="_blank"
      rel="noreferrer"
      variant="default"
      rightSection={<IconExternalLink size={16} />}
    >
      {label}
    </Button>
  );
}

export function TailscaleSettings() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const query = useQuery(tailscaleQueryOptions);
  const request = useRef<TailscaleConfigureInput | null>(null);
  const mutation = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    gcTime: 0,
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: tailscaleQueryOptions.queryKey }),
    // Mutation variables are cached. Read a single-use request instead.
    mutationFn: async () => {
      const data = request.current;
      request.current = null;
      if (!data) throw new Error('Connection request is unavailable.');
      return configureTailscale({ data });
    },
    onSuccess: (status) => {
      queryClient.setQueryData(tailscaleQueryOptions.queryKey, status);
    },
  });
  if (!query.data) {
    if (!query.error) {
      return (
        <Stack gap="lg">
          <Skeleton height={28} width={160} />
          <Skeleton height={60} />
          <Skeleton height={84} />
          <Skeleton height={36} width={170} />
        </Stack>
      );
    }
    return (
      <Alert
        color="red"
        title={t('tailscale.statusUnavailable')}
        icon={<IconAlertCircle size={18} />}
      >
        <Stack gap="sm" align="flex-start">
          <Text size="sm">
            {errorText(query.error, 'tailscale.statusLoadFailed')}
          </Text>
          <Button
            type="button"
            variant="default"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            {t('common.tryAgain')}
          </Button>
        </Stack>
      </Alert>
    );
  }
  const error = mutation.error ?? query.error;
  return (
    <TailscalePanel
      status={query.data}
      pending={mutation.isPending}
      error={error ? errorText(error, 'tailscale.updateFailed') : null}
      onConfigure={async (input) => {
        request.current = input;
        try {
          return await mutation.mutateAsync();
        } finally {
          request.current = null;
        }
      }}
    />
  );
}

export function TailscalePanel({
  status,
  pending,
  error,
  onConfigure,
}: {
  status: TailscaleStatus;
  pending: boolean;
  error: string | null;
  onConfigure: (config: TailscaleConfigureInput) => Promise<TailscaleStatus>;
}) {
  const { t, locale } = useI18n();
  const [hostname, setHostname] = useState<string | null>(null);
  const [copiedOrigin, setCopiedOrigin] = useState<string | null>(null);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('interactive');
  const [authKey, setAuthKey] = useState('');
  const submitting = useRef(false);
  const authorization = useRef<{
    popup: Window | null;
    ready: boolean;
    navigated: boolean;
  } | null>(null);
  const finishAuthorization = useCallback(() => {
    authorization.current?.popup?.close();
    authorization.current = null;
  }, []);
  const syncAuthorization = useCallback(
    (next: TailscaleStatus) => {
      const attempt = authorization.current;
      if (!attempt?.ready) return;
      if (next.state === 'needs-login') {
        if (
          !attempt.navigated &&
          attempt.popup &&
          !attempt.popup.closed &&
          tailscaleLoginUrlSchema.safeParse(next.loginUrl).success
        ) {
          try {
            attempt.popup.location.replace(next.loginUrl!);
            attempt.navigated = true;
          } catch {
            // The user can continue through the normal link if navigation is
            // blocked by the browser or its cross-origin window policy.
            attempt.popup.close();
            attempt.popup = null;
          }
        }
      } else if (next.state !== 'starting') {
        finishAuthorization();
      }
    },
    [finishAuthorization],
  );
  useEffect(() => syncAuthorization(status), [status, syncAuthorization]);
  useEffect(() => {
    if (error && !pending) finishAuthorization();
  }, [error, pending, finishAuthorization]);
  useEffect(
    () => () => {
      // Do not interrupt an authorization already handed to Tailscale when
      // the user navigates away from Settings.
      const attempt = authorization.current;
      if (attempt && !attempt.navigated) attempt.popup?.close();
      authorization.current = null;
    },
    [],
  );
  const canAuthenticate =
    !status.enabled ||
    status.state === 'needs-login' ||
    (status.state === 'error' && !status.dns && !status.https);
  const usesAuthKey = canAuthenticate && loginMethod === 'auth-key';
  const connect = async (deviceName: string) => {
    if (pending || submitting.current || !status.available) return;
    const key = usesAuthKey ? tailscaleAuthKeySchema.safeParse(authKey) : null;
    if (key && !key.success) return;
    submitting.current = true;
    finishAuthorization();
    const attempt = {
      popup: !key
        ? openTailscaleAuthorization({
            lang: locale,
            title: t('tailscale.popup.title'),
            heading: t('tailscale.popup.heading'),
            message: t('tailscale.popup.message'),
          })
        : null,
      ready: false,
      navigated: false,
    };
    authorization.current = attempt;
    setAuthKey('');
    try {
      const next = await onConfigure({
        enabled: true,
        hostname: deviceName,
        ...(key?.success ? { authKey: key.data } : {}),
      });
      if (authorization.current !== attempt) return;
      attempt.ready = true;
      syncAuthorization(next);
    } catch {
      if (authorization.current === attempt) finishAuthorization();
    } finally {
      submitting.current = false;
    }
  };
  const name = status.enabled ? status.hostname : (hostname ?? status.hostname);
  const validName =
    tailscaleConfigSchema.shape.hostname.safeParse(name).success;
  const validKey = tailscaleAuthKeySchema.safeParse(authKey).success;
  const keyReady = !usesAuthKey || validKey;
  const chooseLoginMethod = (value: string) => {
    // Re-selecting the current method must not close a pending sign-in.
    if (value === loginMethod) return;
    finishAuthorization();
    setAuthKey('');
    setLoginMethod(value === 'auth-key' ? 'auth-key' : 'interactive');
  };
  const disconnect = () => {
    const apply = () => {
      finishAuthorization();
      setAuthKey('');
      void onConfigure({ enabled: false, hostname: status.hostname }).catch(
        () => {},
      );
    };
    if (window.location.origin !== status.origin) {
      apply();
      return;
    }
    modals.openConfirmModal({
      title: t('tailscale.disconnectConfirm.title'),
      children: <Text size="sm">{t('tailscale.disconnectConfirm.body')}</Text>,
      labels: {
        confirm: t('tailscale.disconnect'),
        cancel: t('tailscale.disconnectConfirm.keep'),
      },
      confirmProps: { color: 'red' },
      onConfirm: apply,
    });
  };
  const httpsProblem =
    status.state === 'error' && status.https
      ? HTTPS_PROBLEMS[status.https.phase]
      : undefined;
  // Helpers without HTTPS phases only report an error with both DNS settings
  // on when the certificate or HTTPS listener is not ready.
  const httpsNotReady =
    !status.https &&
    status.dns?.magicDnsEnabled === true &&
    status.dns.httpsCertificatesEnabled === true;
  // Errors that still allow signing in mean the connection itself failed;
  // DNS and certificate problems are settings the user can fix and wait on.
  const connectionFailed = status.state === 'error' && canAuthenticate;
  const problemTitle = t(
    httpsProblem?.title ??
      (httpsNotReady
        ? 'tailscale.problem.httpsNotReady'
        : connectionFailed
          ? 'tailscale.problem.connectionFailed'
          : 'tailscale.problem.needsAttention'),
  );
  const problemMessage = status.message
    ? translateError(
        t,
        locale,
        { code: statusMessageCode(status), message: status.message },
        'tailscale.problem.fallback',
      )
    : null;
  const problemColor =
    httpsProblem?.color ?? (connectionFailed ? 'red' : 'yellow');
  const retryAt =
    status.https?.phase === 'rate-limited' ? status.https.retryAt : null;
  const retryTime = retryAt ? dayjs(retryAt) : null;
  const retryClock = retryTime?.isValid()
    ? new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(retryTime.toDate())
    : '';
  const retryLabel = !retryTime?.isValid()
    ? ''
    : retryTime.isSame(dayjs(), 'day')
      ? retryClock
      : t('tailscale.retry.dateTime', {
          date: new Intl.DateTimeFormat(locale, {
            month: 'short',
            day: 'numeric',
          }).format(retryTime.toDate()),
          time: retryClock,
        });
  // Typed helper statuses decide from their phase; older helpers only
  // identify DNS or certificate settings problems through their message.
  const showDnsSettings = httpsProblem
    ? httpsProblem.dnsSettings
    : Boolean(status.dns) ||
      /dns|certificate settings/i.test(status.message ?? '');
  const badge = httpsProblem
    ? { label: httpsProblem.badge, color: httpsProblem.color }
    : {
        label: STATES[status.state].label,
        color:
          status.state === 'error' ? problemColor : STATES[status.state].color,
      };
  const working =
    status.state === 'starting' || status.state === 'preparing-https';
  // Restarting cannot lift a provider rate limit; the helper already waits
  // until the retry time. A pending interactive sign-in continues through its
  // authorization link instead.
  const submitLabel: PlainTranslationKey | null = !status.enabled
    ? 'tailscale.connect'
    : (status.state === 'error' && status.https?.phase !== 'rate-limited') ||
        (status.state === 'needs-login' && usesAuthKey)
      ? 'tailscale.reconnect'
      : null;

  return (
    <Stack gap="lg">
      <div className={classes.status}>
        <div className={classes.statusMain}>
          <Badge
            size="lg"
            radius="sm"
            variant="light"
            color={badge.color}
            leftSection={
              working && !httpsProblem ? (
                <Loader size={10} color={badge.color} />
              ) : undefined
            }
            className={classes.badge}
            aria-live="polite"
          >
            {t(badge.label)}
          </Badge>
          {status.enabled && (
            <Text size="sm" c="dimmed" truncate className={classes.device}>
              <Trans
                t={t}
                i18nKey="tailscale.device"
                values={{ hostname: status.hostname }}
                components={{
                  name: (
                    <Text span inherit fw={600} c="var(--mantine-color-text)" />
                  ),
                }}
              />
            </Text>
          )}
        </div>
        {status.enabled && (
          <Button
            type="button"
            variant="default"
            loading={pending}
            onClick={disconnect}
          >
            {working || status.state === 'needs-login'
              ? t('tailscale.cancelConnection')
              : t('tailscale.disconnect')}
          </Button>
        )}
      </div>

      {!status.available && (
        <Alert
          title={t('tailscale.notInstalled.title')}
          color="yellow"
          icon={<IconAlertTriangle size={18} />}
        >
          <Text size="sm">
            <Trans
              t={t}
              i18nKey="tailscale.notInstalled.body"
              values={{ command: 'pnpm tailscale:build' }}
              components={{ code: <Code /> }}
            />
          </Text>
        </Alert>
      )}
      {error && (
        <Alert
          title={t('tailscale.updateFailedTitle')}
          color="red"
          icon={<IconAlertCircle size={18} />}
        >
          {error}
        </Alert>
      )}
      {status.state === 'starting' && (
        <Text component="output" size="sm" c="dimmed">
          {t('tailscale.startingBody')}
        </Text>
      )}
      {status.state === 'needs-login' && loginMethod === 'interactive' && (
        <Alert
          title={t('tailscale.login.title')}
          color="blue"
          role="note"
          icon={<IconInfoCircle size={18} />}
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{t('tailscale.login.body')}</Text>
            {status.loginUrl ? (
              <ExternalButton
                href={status.loginUrl}
                label={t('tailscale.login.continue')}
              />
            ) : (
              <Text component="output" size="sm">
                {t('tailscale.login.preparing')}
              </Text>
            )}
          </Stack>
        </Alert>
      )}
      {status.state === 'needs-approval' && (
        <Alert
          title={t('tailscale.approval.title')}
          color="blue"
          role="note"
          icon={<IconInfoCircle size={18} />}
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              <Trans
                t={t}
                i18nKey="tailscale.approval.body"
                values={{ hostname: status.hostname }}
                components={{ name: <Text span inherit fw={700} /> }}
              />
            </Text>
            <ExternalButton
              href={DEVICES_URL}
              label={t('tailscale.approval.openDevices')}
            />
          </Stack>
        </Alert>
      )}
      {status.state === 'preparing-https' && (
        <Alert
          title={t('tailscale.preparing.title')}
          color="blue"
          role="note"
          aria-live="polite"
          icon={<IconInfoCircle size={18} />}
        >
          <Text size="sm">{t('tailscale.preparing.body')}</Text>
        </Alert>
      )}
      {problemMessage && status.state !== 'preparing-https' && (
        <Alert
          title={problemTitle}
          color={problemColor}
          icon={
            problemColor === 'red' ? (
              <IconAlertCircle size={18} />
            ) : (
              <IconAlertTriangle size={18} />
            )
          }
        >
          <Stack gap="sm" align="flex-start">
            <Text size="sm">{problemMessage}</Text>
            {retryAt && retryLabel && (
              <Text size="sm">
                <Trans
                  t={t}
                  i18nKey="tailscale.retry.next"
                  values={{ when: retryLabel }}
                  components={{
                    time: (
                      <Text span fw={600} component="time" dateTime={retryAt} />
                    ),
                  }}
                />
              </Text>
            )}
            {status.dns && (
              <Table
                aria-label={t('tailscale.dns.tableLabel')}
                w="auto"
                fz="sm"
                horizontalSpacing={0}
                verticalSpacing={4}
                withRowBorders={false}
              >
                <Table.Tbody>
                  <DnsSettingRow
                    name="MagicDNS"
                    enabled={status.dns.magicDnsEnabled}
                  />
                  <DnsSettingRow
                    name={t('tailscale.dns.httpsCertificates')}
                    enabled={status.dns.httpsCertificatesEnabled}
                  />
                </Table.Tbody>
              </Table>
            )}
            {showDnsSettings && (
              <ExternalButton
                href={DNS_SETTINGS_URL}
                label={t('tailscale.dns.openSettings')}
              />
            )}
          </Stack>
        </Alert>
      )}
      {status.state === 'connected' && status.origin && (
        <Stack gap="xs">
          <Text size="sm" fw={700}>
            {t('tailscale.address.title')}
          </Text>
          <Anchor
            href={status.origin}
            target="_blank"
            rel="noreferrer"
            fw={600}
            td="underline"
            className={classes.address}
          >
            {status.origin}
          </Anchor>
          <Text size="sm" c="dimmed">
            {t('tailscale.address.hint')}
          </Text>
          <Group gap="sm" mt={4}>
            <Button
              type="button"
              variant="default"
              leftSection={
                copiedOrigin === status.origin ? (
                  <IconCheck size={16} />
                ) : (
                  <IconCopy size={16} />
                )
              }
              onClick={async () => {
                if (await copy(status.origin!)) {
                  setCopiedOrigin(status.origin);
                  toast.success(t('tailscale.address.copied'));
                } else {
                  toast.error(t('tailscale.address.copyFailed'));
                }
              }}
            >
              {t('tailscale.address.copy')}
            </Button>
            <Button
              component="a"
              href={status.origin}
              target="_blank"
              rel="noreferrer"
              variant="light"
              rightSection={<IconExternalLink size={16} />}
            >
              {t('tailscale.address.open')}
            </Button>
          </Group>
        </Stack>
      )}

      {(canAuthenticate || submitLabel) && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (submitLabel && validName && keyReady) void connect(name);
          }}
        >
          <Stack gap="lg">
            {!status.enabled && (
              <TextInput
                label={t('tailscale.deviceName.label')}
                description={t('tailscale.deviceName.description')}
                value={name}
                onChange={(event) => setHostname(event.currentTarget.value)}
                disabled={pending}
                maxLength={63}
                error={
                  !validName ? t('tailscale.deviceName.invalid') : undefined
                }
              />
            )}
            {canAuthenticate && (
              <Radio.Group
                label={t('tailscale.method.label')}
                value={loginMethod}
                onChange={chooseLoginMethod}
              >
                <div className={classes.methods}>
                  {LOGIN_METHODS.map((method) => (
                    <Radio.Card
                      key={method.value}
                      value={method.value}
                      disabled={pending}
                      className={classes.method}
                    >
                      <Radio.Indicator className={classes.methodIndicator} />
                      <div>
                        <Text size="sm" fw={600}>
                          {t(method.label)}
                        </Text>
                        <Text size="sm" c="dimmed">
                          {t(method.description)}
                        </Text>
                      </div>
                    </Radio.Card>
                  ))}
                </div>
              </Radio.Group>
            )}
            {usesAuthKey && (
              <PasswordInput
                visibilityToggleButtonProps={{
                  'aria-label': t('system.togglePasswordVisibility'),
                }}
                label={t('tailscale.method.authKey')}
                description={
                  <Trans
                    t={t}
                    i18nKey="tailscale.authKey.description"
                    components={{
                      link: (
                        <Anchor
                          href={AUTH_KEYS_URL}
                          target="_blank"
                          rel="noreferrer"
                          inherit
                          td="underline"
                        />
                      ),
                    }}
                  />
                }
                placeholder="tskey-auth-…"
                value={authKey}
                disabled={pending}
                maxLength={4096}
                // A single-use enrollment key is not a site password: keep
                // spelling services and password managers away from it.
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                onChange={(event) => setAuthKey(event.currentTarget.value)}
                error={
                  authKey && !validKey
                    ? t('tailscale.authKey.invalid')
                    : undefined
                }
              />
            )}
            {submitLabel && (
              <Group>
                <Button
                  type="submit"
                  loading={pending}
                  disabled={!status.available || !validName || !keyReady}
                >
                  {t(submitLabel)}
                </Button>
              </Group>
            )}
          </Stack>
        </form>
      )}

      <Divider />
      <Text size="sm" c="dimmed">
        {t('tailscale.footer')}
      </Text>
    </Stack>
  );
}
