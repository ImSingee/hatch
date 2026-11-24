import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import type { Passkey } from '@better-auth/passkey';
import {
  IconAlertCircle,
  IconCheck,
  IconEdit,
  IconKey,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { getAuthenticatorName } from '~auth/authenticator-names';
import { getPasskeyOriginError } from '~auth/passkey-origin';
import {
  browserSupportsPasskeys,
  isPasskeyCancellation,
  type PasskeyClientError,
} from '~auth/passkey-browser';
import { type PlainTranslationKey, translateError, useI18n } from '~i18n';
import classes from './passkeys-panel.module.css';

type Translate = ReturnType<typeof useI18n>['t'];

type EditingName = {
  id: string;
  value: string;
};

export function PasskeysPanel({ appOrigin }: { appOrigin: string }) {
  const { t, locale } = useI18n();
  const { data: passkeys, isPending, error } = authClient.useListPasskeys();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EditingName | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const supported = browserSupportsPasskeys(appOrigin);
  const originError = getPasskeyOriginError(appOrigin, window.location.origin);
  const editingId = editing?.id;

  useEffect(() => {
    if (editingId) nameInputRef.current?.focus();
  }, [editingId]);

  // Better Auth reports a stable code; codes without a catalog entry keep the
  // English message in English and show `fallback` elsewhere.
  const passkeyError = (
    error: PasskeyClientError,
    fallback: PlainTranslationKey,
  ) =>
    translateError(
      t,
      locale,
      {
        code: error.code ? `passkeys.${error.code}` : undefined,
        message: error.message?.trim(),
      },
      fallback,
    );

  const addPasskey = async () => {
    setAdding(true);
    try {
      const result = await authClient.passkey.addPasskey();
      if (result.error) {
        if (!isPasskeyCancellation(result.error)) {
          toast.error(passkeyError(result.error, 'account.passkeys.addFailed'));
        }
        return;
      }

      toast.success(t('account.passkeys.added'));
    } catch {
      toast.error(t('account.passkeys.addFailedRetry'));
    } finally {
      setAdding(false);
    }
  };

  const saveName = async () => {
    if (!editing) return;

    const name = editing.value.trim();
    if (!name) return;

    setSavingId(editing.id);
    try {
      const result = await authClient.passkey.updatePasskey({
        id: editing.id,
        name,
      });
      if (result.error) {
        toast.error(
          passkeyError(result.error, 'account.passkeys.renameFailed'),
        );
        return;
      }

      setEditing(null);
      toast.success(t('account.passkeys.renamed'));
    } catch {
      toast.error(t('account.passkeys.renameFailedRetry'));
    } finally {
      setSavingId(null);
    }
  };

  const deletePasskey = async (passkey: Passkey) => {
    setDeletingId(passkey.id);
    try {
      const result = await authClient.passkey.deletePasskey({ id: passkey.id });
      if (result.error) {
        toast.error(
          passkeyError(result.error, 'account.passkeys.deleteFailed'),
        );
        return;
      }

      if (editing?.id === passkey.id) setEditing(null);
      toast.success(t('account.passkeys.deleted'));
    } catch {
      toast.error(t('account.passkeys.deleteFailedRetry'));
    } finally {
      setDeletingId(null);
    }
  };

  const confirmDelete = (passkey: Passkey) => {
    const name = displayName(passkey, t);
    modals.openConfirmModal({
      title: t('account.passkeys.confirmTitle', { name }),
      centered: true,
      children: <Text size="sm">{t('account.passkeys.confirmBody')}</Text>,
      labels: {
        confirm: t('account.passkeys.confirm'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'red' },
      onConfirm: () => void deletePasskey(passkey),
    });
  };

  return (
    <Stack gap="md">
      <Group
        justify="space-between"
        align="flex-start"
        className={classes.header}
      >
        <Stack gap={2} style={{ flex: '1 1 220px' }}>
          <Text fw={700}>{t('account.passkeys.title')}</Text>
          <Text size="sm" c="dimmed">
            {t('account.passkeys.description')}
          </Text>
        </Stack>
        <Button
          leftSection={<IconPlus size={16} stroke={1.8} />}
          loading={adding}
          disabled={!supported}
          onClick={addPasskey}
          className={classes.addButton}
        >
          {t('account.passkeys.add')}
        </Button>
      </Group>

      {!supported && (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={
            originError
              ? t('account.passkeys.originUnavailable')
              : t('account.passkeys.browserUnavailable')
          }
          color="yellow"
        >
          {/* The origin check has one requirement, worded in the catalog. */}
          {originError
            ? t('account.passkeys.originUnavailableBody')
            : t('account.passkeys.browserUnavailableBody')}
        </Alert>
      )}

      {isPending ? (
        <PasskeysSkeleton />
      ) : error ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title={t('account.passkeys.loadFailed')}
          color="red"
        >
          {t('account.passkeys.loadFailedBody')}
        </Alert>
      ) : passkeys && passkeys.length > 0 ? (
        <div className={classes.list}>
          {passkeys.map((passkey) => {
            const name = displayName(passkey, t);
            const isEditing = editing?.id === passkey.id;

            return (
              <div className={classes.row} key={passkey.id}>
                <Group gap="sm" wrap="nowrap" className={classes.identity}>
                  <ThemeIcon variant="light" size="lg" radius="md">
                    <IconKey size={18} stroke={1.7} />
                  </ThemeIcon>
                  {isEditing ? (
                    <TextInput
                      aria-label={t('account.passkeys.nameFor', { name })}
                      value={editing.value}
                      onChange={(event) =>
                        setEditing({
                          id: passkey.id,
                          value: event.currentTarget.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveName();
                        if (event.key === 'Escape') setEditing(null);
                      }}
                      disabled={savingId === passkey.id}
                      error={
                        editing.value.trim()
                          ? undefined
                          : t('account.passkeys.nameRequired')
                      }
                      ref={nameInputRef}
                      className={classes.nameInput}
                    />
                  ) : (
                    <Stack gap={0} miw={0}>
                      <Text size="sm" fw={700} truncate>
                        {name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t('account.passkeys.createdOn', {
                          date: new Intl.DateTimeFormat(locale, {
                            dateStyle: 'medium',
                          }).format(new Date(passkey.createdAt)),
                        })}
                      </Text>
                    </Stack>
                  )}
                </Group>

                <Group gap={4} wrap="nowrap" className={classes.actions}>
                  {isEditing ? (
                    <>
                      <Tooltip label={t('account.passkeys.saveName')}>
                        <ActionIcon
                          variant="subtle"
                          aria-label={t('account.passkeys.saveNameFor', {
                            name,
                          })}
                          loading={savingId === passkey.id}
                          disabled={!editing.value.trim()}
                          onClick={() => void saveName()}
                        >
                          <IconCheck size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('common.cancel')}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t('account.passkeys.cancelRename', {
                            name,
                          })}
                          disabled={savingId === passkey.id}
                          onClick={() => setEditing(null)}
                        >
                          <IconX size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Tooltip label={t('common.rename')}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          aria-label={t('account.passkeys.renameName', {
                            name,
                          })}
                          disabled={deletingId === passkey.id}
                          onClick={() =>
                            setEditing({ id: passkey.id, value: name })
                          }
                        >
                          <IconEdit size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('common.delete')}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('account.passkeys.deleteName', {
                            name,
                          })}
                          loading={deletingId === passkey.id}
                          onClick={() => confirmDelete(passkey)}
                        >
                          <IconTrash size={17} stroke={1.7} />
                        </ActionIcon>
                      </Tooltip>
                    </>
                  )}
                </Group>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={classes.empty}>
          <ThemeIcon variant="light" size={42} radius="xl">
            <IconKey size={21} stroke={1.7} />
          </ThemeIcon>
          <Stack gap={2} align="center">
            <Text size="sm" fw={700}>
              {t('account.passkeys.empty')}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {supported
                ? t('account.passkeys.emptyBody')
                : t('account.passkeys.emptyUnsupported')}
            </Text>
          </Stack>
        </div>
      )}
    </Stack>
  );
}

function displayName(passkey: Passkey, t: Translate): string {
  return (
    passkey.name?.trim() ||
    getAuthenticatorName(passkey.aaguid) ||
    t('account.passkeys.defaultName')
  );
}

function PasskeysSkeleton() {
  const { t } = useI18n();
  return (
    <Stack gap="xs" aria-label={t('account.passkeys.loading')}>
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="35%" radius="sm" />
            <Skeleton height={10} width="24%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}
