import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconPlus,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { apiKeyOptions } from '~auth/api-key-options';
import type {
  ApiKey,
  CreatedApiKey,
  CreateApiKeyInput,
} from '~queries/api-keys';
import { type Locale, useErrorText, useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import {
  apiKeysQueryOptions,
  createApiKey,
  revokeApiKey,
} from '~queries/api-keys';
import classes from './api-keys-panel.module.css';

const DAY_SECONDS = 86_400;
const EXPIRING_SOON_DAYS = 7;
/** The date picker's own field format: language-independent. */
const PICKER_DATE_FORMAT = 'YYYY-MM-DD';

const EXPIRATION_VALUES = ['7', '30', '90', '365', 'custom', 'never'] as const;
const DEFAULT_EXPIRATION = '30';

type Translate = ReturnType<typeof useI18n>['t'];

function expirationLabel(value: string, t: Translate): string {
  if (value === 'custom') return t('apiKeys.expiration.custom');
  if (value === 'never') return t('apiKeys.expiration.never');
  if (value === '365') return t('apiKeys.expiration.oneYear');
  return t('apiKeys.expiration.days', { count: Number(value) });
}

/** A date as the reader's language writes it, e.g. "Nov 30, 2026". */
function formatDate(value: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    dayjs(value).toDate(),
  );
}
const REVOKE_MUTATION_KEY = ['auth', 'api-keys', 'revoke'];

/** Which dismissal gestures the create dialog accepts in each step. */
type CreatePhase = 'editing' | 'creating' | 'created';

export function ApiKeysPanel() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const keys = useQuery(apiKeysQueryOptions);
  const [createOpened, setCreateOpened] = useState(false);
  const [createPhase, setCreatePhase] = useState<CreatePhase>('editing');
  const [createFlowId, setCreateFlowId] = useState(0);

  const revoke = useMutation({
    networkMode: 'always',
    retry: false,
    mutationKey: REVOKE_MUTATION_KEY,
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData(apiKeysQueryOptions.queryKey, (current) =>
        current?.filter((key) => key.id !== id),
      );
      toast.success(t('apiKeys.revoked'));
    },
    // Failures are toasted by the global mutation handler; refetch so a key
    // already revoked elsewhere disappears instead of lingering.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: apiKeysQueryOptions.queryKey,
      }),
  });
  const revokingIds = useMutationState({
    filters: { mutationKey: REVOKE_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  const openCreate = () => {
    // A fresh flow per opening: reopening during the close transition must
    // never bring back a previously revealed key.
    setCreateFlowId((id) => id + 1);
    setCreatePhase('editing');
    setCreateOpened(true);
  };

  const closeCreate = () => {
    if (createPhase !== 'creating') setCreateOpened(false);
  };

  const confirmRevoke = (key: ApiKey) =>
    modals.openConfirmModal({
      title: t('apiKeys.revokeTitle', { name: key.name }),
      centered: true,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            <Trans
              t={t}
              i18nKey="apiKeys.revokeImpact"
              values={{ key: maskedIdentifier(key) }}
              components={{ code: <Code /> }}
            />
          </Text>
          <Text size="sm">{t('apiKeys.revokePermanent')}</Text>
        </Stack>
      ),
      labels: {
        confirm: t('apiKeys.revokeConfirm'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => revoke.mutate(key.id),
    });

  return (
    <Stack gap="md">
      <Group
        justify="space-between"
        align="flex-start"
        className={classes.header}
      >
        <Stack gap={2} style={{ flex: '1 1 220px' }}>
          <Text fw={700}>{t('apiKeys.title')}</Text>
          <Text size="sm" c="dimmed">
            {t('apiKeys.description')}
          </Text>
        </Stack>
        <Button
          type="button"
          leftSection={<IconPlus size={16} stroke={1.8} />}
          onClick={openCreate}
          className={classes.addButton}
        >
          {t('apiKeys.create')}
        </Button>
      </Group>

      {keys.isPending ? (
        <ApiKeysSkeleton />
      ) : keys.isError ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={t('apiKeys.loadFailed')}
          color="red"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">
              {errorText(keys.error, 'apiKeys.unavailable')}
            </Text>
            <Button
              type="button"
              size="xs"
              variant="light"
              color="red"
              loading={keys.isFetching}
              onClick={() => void keys.refetch()}
            >
              {t('common.tryAgain')}
            </Button>
          </Stack>
        </Alert>
      ) : keys.data.length > 0 ? (
        <ul className={classes.list} aria-label={t('apiKeys.title')}>
          {keys.data.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              revoking={revokingIds.includes(key.id)}
              onRevoke={() => confirmRevoke(key)}
            />
          ))}
        </ul>
      ) : (
        <div className={classes.empty}>
          <ThemeIcon variant="light" size={42} radius="xl">
            <IconTerminal2 size={21} stroke={1.7} />
          </ThemeIcon>
          <Stack gap={2} align="center">
            <Text size="sm" fw={700}>
              {t('apiKeys.empty')}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {t('apiKeys.emptyBody')}
            </Text>
          </Stack>
        </div>
      )}

      <Modal
        opened={createOpened}
        onClose={closeCreate}
        title={
          createPhase === 'created'
            ? t('apiKeys.copyTitle')
            : t('apiKeys.newTitle')
        }
        centered
        // A revealed key is shown only once, so only deliberate actions may
        // dismiss it; nothing can dismiss the dialog mid-request.
        closeOnEscape={createPhase === 'editing'}
        closeOnClickOutside={createPhase === 'editing'}
        closeButtonProps={{
          'aria-label': t('common.close'),
          disabled: createPhase === 'creating',
        }}
      >
        {/* Mantine unmounts the body once the dialog has closed, discarding
            the form and the one-time secret held in this subtree's state. */}
        <CreateApiKeyFlow
          key={createFlowId}
          onPhaseChange={setCreatePhase}
          onCancel={closeCreate}
          onDone={() => setCreateOpened(false)}
        />
      </Modal>
    </Stack>
  );
}

function ApiKeyRow({
  apiKey,
  revoking,
  onRevoke,
}: {
  apiKey: ApiKey;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const { t, locale } = useI18n();
  const expiry = expiryStatus(apiKey.expiresAt, t, locale);

  return (
    <li className={classes.row}>
      <Group
        gap="sm"
        wrap="nowrap"
        align="flex-start"
        className={classes.identity}
      >
        <ThemeIcon
          variant="light"
          color={expiry.expired ? 'gray' : undefined}
          size="lg"
          radius="md"
        >
          <IconTerminal2 size={18} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={4} miw={0} flex={1}>
          <Group gap={8} wrap="nowrap" miw={0}>
            <Text size="sm" fw={700} truncate>
              {apiKey.name}
            </Text>
            {expiry.badge && (
              <Badge
                size="sm"
                variant="light"
                color={expiry.expired ? 'red' : 'amber'}
                className={classes.badge}
              >
                {expiry.badge}
              </Badge>
            )}
          </Group>
          <Code className={classes.identifier}>{maskedIdentifier(apiKey)}</Code>
          <div className={classes.metaClip}>
            <Text size="xs" c="dimmed" className={classes.meta}>
              <span>
                {t('apiKeys.created', {
                  date: formatDate(apiKey.createdAt, locale),
                })}
              </span>
              <span>{expiry.label}</span>
              <span>
                {apiKey.lastRequest
                  ? t('apiKeys.lastUsed', {
                      when: formatRelativeTime(apiKey.lastRequest, locale),
                    })
                  : t('apiKeys.neverUsed')}
              </span>
            </Text>
          </div>
        </Stack>
      </Group>

      <Tooltip label={t('apiKeys.revoke')}>
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={t('apiKeys.revokeName', { name: apiKey.name })}
          loading={revoking}
          onClick={onRevoke}
          className={classes.revoke}
        >
          <IconTrash size={17} stroke={1.7} />
        </ActionIcon>
      </Tooltip>
    </li>
  );
}

function CreateApiKeyFlow({
  onPhaseChange,
  onCancel,
  onDone,
}: {
  onPhaseChange: (phase: CreatePhase) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiration, setExpiration] = useState(DEFAULT_EXPIRATION);
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const inFlight = useRef(false);

  const create = useMutation({
    // Credentials must fail now when offline, never replay on reconnection.
    networkMode: 'always',
    retry: false,
    // Failures are shown inline next to the form instead of as a toast.
    meta: { errorToast: false },
    mutationFn: async (input: CreateApiKeyInput) => {
      const result = await createApiKey(input);
      // Hand the one-time secret straight to component memory and resolve
      // with nothing, so the mutation cache never holds it.
      setCreated(result);
      onPhaseChange('created');
    },
    onError: () => onPhaseChange('editing'),
    onSettled: () => {
      inFlight.current = false;
      return queryClient.invalidateQueries({
        queryKey: apiKeysQueryOptions.queryKey,
      });
    },
  });

  if (created) return <RevealedApiKey created={created} onDone={onDone} />;

  const trimmedName = name.trim();
  const nameError = trimmedName ? null : t('apiKeys.nameRequired');
  const dateError =
    expiration === 'custom' && !customDate ? t('apiKeys.dateRequired') : null;
  const today = dayjs();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setShowErrors(true);
    if (nameError || dateError) return;

    inFlight.current = true;
    onPhaseChange('creating');
    create.mutate({
      name: trimmedName,
      expiresIn: lifetimeSeconds(expiration, customDate),
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('apiKeys.scope')}
        </Text>
        <TextInput
          label={t('apiKeys.nameLabel')}
          placeholder={t('apiKeys.namePlaceholder')}
          description={t('apiKeys.nameDescription')}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          maxLength={apiKeyOptions.maximumNameLength}
          error={showErrors ? nameError : null}
          readOnly={create.isPending}
          autoComplete="off"
          withAsterisk
          data-autofocus
        />
        <Stack gap={6}>
          <Select
            label={t('apiKeys.expirationLabel')}
            data={EXPIRATION_VALUES.map((value) => ({
              value,
              label: expirationLabel(value, t),
            }))}
            value={expiration}
            onChange={(value) => value && setExpiration(value)}
            allowDeselect={false}
            readOnly={create.isPending}
            comboboxProps={{ withinPortal: true }}
          />
          {expiration === 'custom' && (
            <DatePickerInput
              label={t('apiKeys.expirationDate')}
              placeholder={t('apiKeys.pickDate')}
              value={customDate}
              onChange={setCustomDate}
              minDate={today.add(1, 'day').format(PICKER_DATE_FORMAT)}
              maxDate={today
                .add(apiKeyOptions.keyExpiration.maxExpiresIn - 1, 'day')
                .format(PICKER_DATE_FORMAT)}
              valueFormat={PICKER_DATE_FORMAT}
              ariaLabels={{
                monthLevelControl: t('apiKeys.calendar.month'),
                yearLevelControl: t('apiKeys.calendar.year'),
                nextMonth: t('apiKeys.calendar.nextMonth'),
                previousMonth: t('apiKeys.calendar.previousMonth'),
                nextYear: t('apiKeys.calendar.nextYear'),
                previousYear: t('apiKeys.calendar.previousYear'),
                nextDecade: t('apiKeys.calendar.nextDecade'),
                previousDecade: t('apiKeys.calendar.previousDecade'),
              }}
              error={showErrors ? dateError : null}
              readOnly={create.isPending}
            />
          )}
          <ExpirationHint expiration={expiration} customDate={customDate} />
        </Stack>

        {create.isError && (
          <Alert
            color="red"
            icon={<IconAlertCircle size={18} />}
            title={t('apiKeys.createUnconfirmed')}
          >
            <Stack gap="xs">
              <Text size="sm">
                {errorText(create.error, 'apiKeys.unavailable')}
              </Text>
              <Text size="sm">{t('apiKeys.createUnconfirmedBody')}</Text>
            </Stack>
          </Alert>
        )}

        <Group justify="flex-end" gap="sm" className={classes.footer}>
          <Button
            type="button"
            variant="default"
            disabled={create.isPending}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('apiKeys.createKey')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function ExpirationHint({
  expiration,
  customDate,
}: {
  expiration: string;
  customDate: string | null;
}) {
  const { t, locale } = useI18n();
  if (expiration === 'never') {
    return (
      <Text size="xs" c="amber.8" className={classes.hint}>
        <IconAlertTriangle size={14} stroke={1.8} aria-hidden />
        {t('apiKeys.neverExpiresWarning')}
      </Text>
    );
  }
  if (expiration === 'custom') {
    if (!customDate) return null;
    return (
      <Text size="xs" c="dimmed">
        {t('apiKeys.expiresEndOf', { date: formatDate(customDate, locale) })}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      {t('apiKeys.expiresOn', {
        date: formatDate(
          dayjs().add(Number(expiration), 'day').toDate(),
          locale,
        ),
      })}
    </Text>
  );
}

function RevealedApiKey({
  created,
  onDone,
}: {
  created: CreatedApiKey;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  // The submit button that had focus is gone; move focus to the next action.
  useEffect(() => copyButtonRef.current?.focus(), []);

  const copyKey = async () => {
    if (await copy(created.key).catch(() => false)) {
      setCopied(true);
      toast.success(t('apiKeys.copied'));
    } else {
      toast.error(t('apiKeys.copyFailed'));
    }
  };

  return (
    <Stack gap="md">
      <Alert
        color="yellow"
        icon={<IconAlertTriangle size={18} />}
        title={t('apiKeys.onlyOnce')}
      >
        {t('apiKeys.onlyOnceBody')}
      </Alert>

      <Stack gap={6}>
        <Textarea
          label={t('apiKeys.keyFor', { name: created.name })}
          value={created.key}
          readOnly
          autosize
          minRows={2}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          classNames={{ input: classes.secretInput }}
        />
        <Text size="xs" c="dimmed">
          <Trans
            t={t}
            i18nKey="apiKeys.headerHint"
            components={{ code: <Code /> }}
          />{' '}
          {created.expiresAt
            ? t('apiKeys.expires', {
                date: formatDate(created.expiresAt, locale),
              })
            : t('apiKeys.neverExpires')}
        </Text>
      </Stack>

      <Group justify="flex-end" gap="sm" className={classes.footer}>
        <Button type="button" variant="default" onClick={onDone}>
          {t('common.done')}
        </Button>
        <Button
          type="button"
          ref={copyButtonRef}
          variant={copied ? 'light' : 'filled'}
          leftSection={
            copied ? (
              <IconCheck size={16} stroke={1.8} />
            ) : (
              <IconCopy size={16} stroke={1.8} />
            )
          }
          onClick={copyKey}
        >
          {copied ? t('apiKeys.copiedButton') : t('apiKeys.copyKey')}
        </Button>
      </Group>
    </Stack>
  );
}

function ApiKeysSkeleton() {
  const { t } = useI18n();
  return (
    <Stack gap="xs" aria-label={t('apiKeys.loading')} aria-busy>
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="30%" radius="sm" />
            <Skeleton height={10} width="45%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/** The stored leading characters only; the rest of the secret is unknown. */
function maskedIdentifier(key: ApiKey): string {
  const prefix = key.prefix ?? '';
  const leading = key.start ?? '';
  const start = leading.startsWith(prefix) ? leading : `${prefix}${leading}`;
  return `${start}…`;
}

function expiryStatus(
  expiresAt: ApiKey['expiresAt'],
  t: Translate,
  locale: Locale,
): {
  label: string;
  badge: string | null;
  expired: boolean;
} {
  if (!expiresAt) {
    return { label: t('apiKeys.expiryNone'), badge: null, expired: false };
  }
  const at = dayjs(expiresAt);
  const now = dayjs();
  const date = formatDate(at.toDate(), locale);
  if (!at.isAfter(now)) {
    return {
      label: t('apiKeys.expiredOn', { date }),
      badge: t('apiKeys.expiredBadge'),
      expired: true,
    };
  }
  return {
    label: t('apiKeys.expiresDate', { date }),
    badge:
      at.diff(now, 'day', true) <= EXPIRING_SOON_DAYS
        ? t('apiKeys.expiresSoon')
        : null,
    expired: false,
  };
}

function lifetimeSeconds(
  expiration: string,
  customDate: string | null,
): number | null {
  if (expiration === 'never') return null;
  if (expiration === 'custom' && customDate) {
    const seconds = dayjs(customDate).endOf('day').diff(dayjs(), 'second');
    return Math.min(
      Math.max(seconds, 1),
      apiKeyOptions.keyExpiration.maxExpiresIn * DAY_SECONDS,
    );
  }
  return Number(expiration) * DAY_SECONDS;
}
